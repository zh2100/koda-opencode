import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import path from "node:path"
import fs from "node:fs/promises"
import { tmpdir } from "./fixture/tmpdir"

function worker(data: string, name: string, mode: string) {
  const child = spawn(process.execPath, [path.join(import.meta.dir, "fixture/relay-writer.ts"), data, name, mode], {
    cwd: path.join(import.meta.dir, ".."),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  const errors: string[] = []
  child.stderr?.on("data", (data) => errors.push(String(data)))
  let initialized: unknown
  const ready = new Promise<void>((resolve, reject) => {
    child.on("message", (message) => {
      if (message && typeof message === "object" && "ready" in message) {
        initialized = message
        resolve()
      }
    })
    child.on("exit", (code) => reject(new Error(`worker exited before ready: ${code}: ${errors.join("")}`)))
    child.on("error", reject)
  })
  const result = new Promise<boolean>((resolve, reject) => {
    const state = { done: false, conflict: false }
    child.on("message", (message) => {
      if (!message || typeof message !== "object" || !("done" in message)) return
      state.done = true
      state.conflict = "conflict" in message && message.conflict === true
    })
    child.on("exit", (code) =>
      code === 0 && state.done ? resolve(state.conflict) : reject(new Error(errors.join("") || `exit ${code}`)),
    )
    child.on("error", reject)
  })
  // Exit can precede readiness; both promises must already have rejection handlers.
  void result.catch(() => {})
  return { child, ready, result, initial: () => initialized }
}

test("two processes sharing data with separate state preserve auth revisions and independent fallback secrets", async () => {
  await using tmp = await tmpdir()
  for (const mode of ["auth", "secrets"]) {
    const writers = [worker(tmp.path, "writer-a", mode), worker(tmp.path, "writer-b", mode)]
    try {
      await Promise.all(writers.map((item) => item.ready))
      if (mode === "auth") {
        expect(writers[0]!.initial()).toEqual(writers[1]!.initial())
        expect(writers[0]!.initial()).toMatchObject({ revision: 0, entities: {} })
      }
      writers.forEach((item) => item.child.send("go"))
      const result = await Promise.all(writers.map((item) => item.result))
      if (mode === "auth") expect(result.filter(Boolean)).toHaveLength(1)
    } finally {
      writers.forEach((item) => {
        if (item.child.exitCode === null) item.child.kill()
      })
    }
  }
  const config = await Bun.file(path.join(tmp.path, "relay-auth.json")).json()
  const secrets = await Bun.file(path.join(tmp.path, "relay-secrets.json")).json()
  expect(config.revision).toBe(2)
  for (const name of ["writer-a", "writer-b"]) {
    expect(secrets[config.vendors[name].keyRef]).toBe(`key-${name}`)
    expect(secrets[`${name}:0`]).toBeUndefined()
    for (const index of Array.from({ length: 11 }, (_, index) => index + 1)) {
      expect(secrets[`${name}:${index}`]).toBe(`value-${name}-${index}`)
    }
  }
}, 30000)

for (const mode of ["crash-before-commit", "crash-after-commit", "crash-cleanup"]) {
  test(`recovers real process exit at ${mode} without losing the committed credential`, async () => {
    await using tmp = await tmpdir()
    const seed = worker(tmp.path, "checkpoint", "auth")
    await seed.ready
    seed.child.send("go")
    await seed.result
    const original = await Bun.file(path.join(tmp.path, "relay-auth.json")).json()
    const crashing = worker(tmp.path, "checkpoint", mode)
    const exited = new Promise<number | null>((resolve) => crashing.child.once("exit", resolve))
    await crashing.ready
    crashing.child.send("go")
    expect(await exited).toBe(mode === "crash-before-commit" ? 86 : mode === "crash-after-commit" ? 87 : 88)
    const journal = await Bun.file(path.join(tmp.path, "relay-auth-preparing.json")).json()
    expect(journal).toHaveLength(1)
    expect(journal[0]).not.toContain("key-checkpoint")
    const recovering = worker(tmp.path, "checkpoint", "recover")
    await recovering.ready
    recovering.child.send("go")
    await recovering.result
    const config = await Bun.file(path.join(tmp.path, "relay-auth.json")).json()
    const secrets = await Bun.file(path.join(tmp.path, "relay-secrets.json")).json()
    const ref = config.vendors.checkpoint.keyRef
    expect(config.revision).toBe(mode === "crash-before-commit" ? original.revision : original.revision + 1)
    expect(secrets[ref]).toBe(mode === "crash-before-commit" ? "key-checkpoint" : "new-key-checkpoint")
    expect(Object.keys(secrets)).toEqual([ref])
    expect(config.pendingCleanup).toBeUndefined()
    expect(await Bun.file(path.join(tmp.path, "relay-auth-preparing.json")).exists()).toBe(false)
    expect((await fs.readdir(tmp.path)).filter((name) => /^relay-.*\.(tmp|next)$/.test(name))).toEqual([])
  }, 60000)
}

test("B111 a real process commit without a reply is confirmed by another process without recreation", async () => {
  await using tmp = await tmpdir()
  const dropping = worker(tmp.path, "durable-create", "create-receipt-drop-response")
  try {
    await dropping.ready
    dropping.child.send("go")
    await expect(dropping.result).rejects.toBeDefined()
    const before = await Bun.file(path.join(tmp.path, "relay-auth.json")).text()
    const stored = JSON.parse(before)
    expect(stored.creationReceipts).toHaveLength(1)
    const retrying = worker(tmp.path, "durable-create", "create-receipt")
    let report: unknown
    retrying.child.on("message", (message) => {
      if (message && typeof message === "object" && "done" in message) report = message
    })
    try {
      await retrying.ready
      retrying.child.send("go")
      await retrying.result
      expect(report).toMatchObject({
        revision: stored.revision,
        credentialResolved: true,
        receipt: { operationId: "create:durable-create", entityId: stored.vendors["durable-create"].entityId },
      })
      expect(await Bun.file(path.join(tmp.path, "relay-auth.json")).text()).toBe(before)
      expect(Object.keys(await Bun.file(path.join(tmp.path, "relay-secrets.json")).json())).toHaveLength(1)
    } finally {
      if (retrying.child.exitCode === null) retrying.child.kill()
      await retrying.result.catch(() => undefined)
    }
  } finally {
    if (dropping.child.exitCode === null) dropping.child.kill()
    await dropping.result.catch(() => undefined)
  }
}, 30000)

test("B118 real deletion races with durable create confirmation without losing metadata or recreating the vendor", async () => {
  await using tmp = await tmpdir()
  const name = "delete-race"
  const seed = worker(tmp.path, name, "create-receipt")
  try {
    await seed.ready
    seed.child.send("go")
    await seed.result
  } finally {
    if (seed.child.exitCode === null) seed.child.kill()
    await seed.result.catch(() => undefined)
  }
  const before = await Bun.file(path.join(tmp.path, "relay-auth.json")).json()
  await Bun.write(path.join(tmp.path, "auth.relay-backup.json"), "{}")
  const racers = [worker(tmp.path, name, "delete-vendor"), worker(tmp.path, name, "create-receipt-racing-delete")]
  try {
    await Promise.all(racers.map((item) => item.ready))
    racers.forEach((item) => item.child.send("go"))
    await Promise.all(racers.map((item) => item.result))
  } finally {
    racers.forEach((item) => {
      if (item.child.exitCode === null) item.child.kill()
    })
    await Promise.allSettled(racers.map((item) => item.result))
  }
  const committed = await Bun.file(path.join(tmp.path, "relay-auth.json")).text()
  const stored = JSON.parse(committed)
  expect(stored.creationReceipts).toEqual(before.creationReceipts)
  expect(stored.vendors[name]).toBeUndefined()
  expect(stored.revision).toBe(before.revision + 1)
  expect(await Bun.file(path.join(tmp.path, "relay-secrets.json")).json()).toEqual({})
  expect(Object.values(stored.vendors).map((item) => (item as { entityId: string }).entityId)).toEqual(
    Object.values(before.vendors)
      .filter((item) => (item as { builtin: boolean }).builtin)
      .map((item) => (item as { entityId: string }).entityId),
  )
  const confirming = worker(tmp.path, name, "create-receipt-after-delete")
  let report: unknown
  confirming.child.on("message", (message) => {
    if (message && typeof message === "object" && "done" in message) report = message
  })
  try {
    await confirming.ready
    confirming.child.send("go")
    await confirming.result
    expect(report).toMatchObject({ revision: stored.revision, receipt: { operationId: "create:" + name } })
    expect(await Bun.file(path.join(tmp.path, "relay-auth.json")).text()).toBe(committed)
  } finally {
    if (confirming.child.exitCode === null) confirming.child.kill()
    await confirming.result.catch(() => undefined)
  }
}, 60000)
