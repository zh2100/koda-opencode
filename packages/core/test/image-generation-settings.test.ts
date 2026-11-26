import path from "path"
import fs from "fs/promises"
import { describe, expect, spyOn, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AtomicDocument } from "@opencode-ai/core/config/atomic-document"
import { ConfigDocument } from "@opencode-ai/core/config/document"
import { Global } from "@opencode-ai/core/global"
import { ImageGenerationSettings } from "@opencode-ai/core/image-generation-settings"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { LockIdentity } from "@opencode-ai/core/util/lock-identity"
import { tmpdir } from "./fixture/tmpdir"
import { verifyLockWorker } from "./support/verify-lock-worker"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
const enabled = { enabled: true, model: "local/image", api: "openai-images" } as const

function layer(directory: string) {
  return AppNodeBuilder.build(LayerNode.group([ImageGenerationSettings.node, EffectFlock.node]), [
    [Global.node, Global.layerWith({ config: directory, state: path.join(directory, "state") })],
  ])
}

describe("ImageGenerationSettings", () => {
  test("preserves BOM, CRLF, comments and unrelated settings", () => {
    const output = ImageGenerationSettings.patchDocument(
      '\uFEFF{\r\n  // keep\r\n  "model": "chat/model",\r\n}\r\n',
      enabled,
    )
    expect(output.startsWith("\uFEFF")).toBe(true)
    expect(output).toContain('// keep\r\n  "model": "chat/model",')
    expect(output.replaceAll("\r\n", "")).not.toContain("\n")
  })

  test("rejects malformed documents and incomplete enabled settings", () => {
    for(const taskRequestLimit of [0,11,1.5]) expect(() => ImageGenerationSettings.patchDocument("{}",{...enabled,taskRequestLimit})).toThrow()
    expect(() => ImageGenerationSettings.patchDocument("{bad", enabled)).toThrow()
    expect(() => ImageGenerationSettings.patchDocument("[]", enabled)).toThrow()
    expect(() => ImageGenerationSettings.patchDocument("{}", { enabled: true })).toThrow()
    expect(() => ImageGenerationSettings.patchDocument("{}", { enabled: true, model: "local/image" })).toThrow()
    expect(() => ImageGenerationSettings.patchDocument("{}", { model: "not-a-ref" })).toThrow()
  })

  it.live("creates persisted settings and observes updates without rebuilding the service", () =>
    Effect.acquireRelease(Effect.promise(tmpdir), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const settings = yield* ImageGenerationSettings.Service
          expect(yield* settings.get()).toEqual({})
          expect(yield* settings.update(enabled)).toEqual(enabled)
          expect(
            JSON.parse(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "opencode.json"), "utf8")))
              .image_generation,
          ).toEqual(enabled)
          expect(yield* settings.get()).toEqual(enabled)
          const automatic = {...enabled,automaticIllustrations:true, taskRequestLimit:3}
          yield* settings.update(automatic)
          expect(yield* settings.get()).toEqual(automatic)
          yield* settings.update({ enabled: false })
          expect(yield* settings.get()).toEqual({ enabled: false })
          expect((yield* Effect.promise(() => fs.readdir(tmp.path))).filter((name) => name.endsWith(".tmp"))).toEqual(
            [],
          )
          expect(
            yield* Effect.promise(() =>
              fs.access(LockIdentity.marker(path.join(tmp.path, "state"))).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false)
        }).pipe(Effect.provide(layer(tmp.path))),
      ),
    ),
    30_000,
  )

  it.live("uses JSONC priority and does not replace unrelated fields or lower priority documents", () =>
    Effect.acquireRelease(Effect.promise(tmpdir), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const legacy = JSON.stringify({ image_generation: enabled })
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(path.join(tmp.path, "config.json"), legacy),
              fs.writeFile(path.join(tmp.path, "opencode.json"), JSON.stringify({ image_generation: enabled })),
              fs.writeFile(
                path.join(tmp.path, "opencode.jsonc"),
                '{\n // keep\n "model": "chat/model", "image_generation": { "enabled": false }\n}\n',
              ),
            ]),
          )
          return yield* Effect.gen(function* () {
            const settings = yield* ImageGenerationSettings.Service
            expect(yield* settings.get()).toEqual({ enabled: false })
            yield* settings.update(enabled)
            expect(yield* settings.get()).toEqual(enabled)
            expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "config.json"), "utf8"))).toBe(legacy)
            const output = yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "opencode.jsonc"), "utf8"))
            expect(output).toContain("// keep")
            expect(output).toContain('"model": "chat/model"')
          }).pipe(Effect.provide(layer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("returns typed errors and leaves malformed existing configuration untouched", () =>
    Effect.acquireRelease(Effect.promise(tmpdir), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "opencode.jsonc"), "{bad"))
          return yield* Effect.gen(function* () {
            const settings = yield* ImageGenerationSettings.Service
            expect(yield* settings.get().pipe(Effect.flip)).toBeInstanceOf(ImageGenerationSettings.Error)
            expect(yield* settings.update(enabled).pipe(Effect.flip)).toBeInstanceOf(ImageGenerationSettings.Error)
            expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "opencode.jsonc"), "utf8"))).toBe("{bad")
            expect((yield* Effect.promise(() => fs.readdir(tmp.path))).filter((name) => name.endsWith(".tmp"))).toEqual(
              [],
            )
          }).pipe(Effect.provide(layer(tmp.path)))
        }),
      ),
    ),
  )
})

test("IMG-T01 unknown publication stays unknown and does not claim the file was unchanged", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "opencode.json")
  const script = `
    const fs = (await import("node:fs/promises")).default
    const { Effect } = await import("effect")
    const { AppNodeBuilder } = await import("@opencode-ai/core/effect/app-node-builder")
    const { Global } = await import("@opencode-ai/core/global")
    const { ImageGenerationSettings } = await import("@opencode-ai/core/image-generation-settings")
    const file = ${JSON.stringify(file)}
    const link = fs.link.bind(fs)
    const stat = fs.stat.bind(fs)
    let calls = 0
    let published = false
    fs.link = async (...args) => { await link(...args); calls++; published = true; throw new Error("secret-token") }
    fs.stat = async (target, ...args) => {
      if (published && String(target) === file) throw Object.assign(new Error("secret-token"), { code: "EPERM" })
      return stat(target, ...args)
    }
    const failed = await Effect.runPromise(Effect.gen(function* () {
      return yield* (yield* ImageGenerationSettings.Service).update({ enabled: true, model: "local/image", api: "openai-images" }).pipe(Effect.flip)
    }).pipe(Effect.provide(AppNodeBuilder.build(ImageGenerationSettings.node, [[Global.node, Global.layerWith({ config: ${JSON.stringify(tmp.path)}, state: ${JSON.stringify(path.join(tmp.path, "state"))} })]]))))
    if (failed.code !== "unknown" || failed.message.includes("not replaced") || failed.message.includes("secret-token") || calls !== 1) throw new Error("classification failed")
    console.log("IMG_T01_UNKNOWN")
  `
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: path.resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(stderr).toBe("")
  expect(code).toBe(0)
  expect(stdout).toContain("IMG_T01_UNKNOWN")
  expect(await fs.readFile(file, "utf8")).toContain("local/image")
})

it.live("IMG-T05 interrupted publication still commits once and then releases the lease", () =>
  Effect.acquireRelease(Effect.promise(tmpdir), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(
    Effect.flatMap((tmp) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const link = fs.link.bind(fs)
        let calls = 0
        const intercepted = spyOn(fs, "link").mockImplementation(async (...args) => {
          calls++
          await Effect.runPromise(Deferred.succeed(entered, undefined))
          await Effect.runPromise(Deferred.await(release))
          return link(...args)
        })
        const services = layer(tmp.path)
        const save = Effect.gen(function* () {
          return yield* (yield* ImageGenerationSettings.Service).update(enabled)
        }).pipe(Effect.provide(services))
        const fiber = yield* save.pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
        yield* Deferred.succeed(release, undefined)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
        expect(calls).toBe(1)
        const file = path.join(tmp.path, "opencode.json")
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toContain("local/image")
        expect(yield* save.pipe(Effect.timeout("20 seconds"), Effect.as(true))).toBe(true)
        intercepted.mockRestore()
      }),
    ),
  ),
)

it.live("IMG-T04 holds the document lease until an interrupted publication settles", () =>
  Effect.acquireRelease(Effect.promise(tmpdir), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(
    Effect.flatMap((tmp) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const link = fs.link.bind(fs)
        const intercepted = spyOn(fs, "link").mockImplementation(async (...args) => {
          await Effect.runPromise(Deferred.succeed(entered, undefined))
          await Effect.runPromise(Deferred.await(release))
          return link(...args)
        })
        const services = layer(tmp.path)
        const save = Effect.gen(function* () {
          return yield* (yield* ImageGenerationSettings.Service).update(enabled)
        }).pipe(Effect.provide(services))
        const fiber = yield* save.pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const file = path.join(tmp.path, "opencode.json")
        const competing = yield* save.pipe(Effect.timeout("200 millis"), Effect.exit)
        expect(Exit.isFailure(competing)).toBe(true)
        yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
        const duringInterrupt = yield* save.pipe(Effect.timeout("200 millis"), Effect.exit)
        expect(Exit.isFailure(duringInterrupt)).toBe(true)
        yield* Deferred.succeed(release, undefined)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toContain("local/image")
        intercepted.mockRestore()
      }),
    ),
  ),
)

it.live("IMG-T06 interrupted publication keeps both the interrupt and the safe failure", () =>
  Effect.acquireRelease(Effect.promise(tmpdir), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(
    Effect.flatMap((tmp) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const intercepted = spyOn(fs, "link").mockImplementation(async () => {
          await Effect.runPromise(Deferred.succeed(entered, undefined))
          await Effect.runPromise(Deferred.await(release))
          throw Object.assign(new Error("secret-token"), { code: "EIO" })
        })
        const services = layer(tmp.path)
        const save = Effect.gen(function* () {
          return yield* (yield* ImageGenerationSettings.Service).update(enabled)
        }).pipe(Effect.provide(services))
        const fiber = yield* save.pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const during = yield* save.pipe(Effect.timeout("200 millis"), Effect.exit)
        expect(Exit.isFailure(during)).toBe(true)
        yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
        yield* Deferred.succeed(release, undefined)
        const exit = yield* Fiber.await(fiber)
        intercepted.mockRestore()
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterrupts(exit.cause)).toBe(true)
          expect(Cause.pretty(exit.cause)).toContain("not replaced")
          expect(Cause.pretty(exit.cause)).not.toContain("secret-token")
        }
        expect(yield* save.pipe(Effect.timeout("20 seconds"), Effect.as(true))).toBe(true)
      }),
    ),
  ),
)

test("IMG-T07a cancellation while waiting for the real document lease leaves no write or lease leak", () => verifyLockWorker("t07a"), 30000)

it.live("IMG-T07b cancellation after acquiring the lease before publication preserves existing bytes", () =>
  Effect.acquireRelease(Effect.promise(tmpdir), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(
    Effect.flatMap((tmp) =>
      Effect.gen(function* () {
        const file = path.join(tmp.path, "opencode.json")
        const before = '{"username":"kept"}\n'
        yield* Effect.promise(() => fs.writeFile(file, before))
        const original = ConfigDocument.withLock
        const intercepted = spyOn(ConfigDocument, "withLock").mockImplementation(((flock, target, body) =>
          original(flock, target, Effect.andThen(Effect.interrupt, body))) as typeof ConfigDocument.withLock)
        const publish = spyOn(AtomicDocument, "publish")
        yield* Effect.gen(function* () {
          const settings = yield* ImageGenerationSettings.Service
          const flock = yield* EffectFlock.Service
          const exit = yield* Effect.exit(settings.update(enabled))
          expect(intercepted).toHaveBeenCalledTimes(1)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
          expect(publish).not.toHaveBeenCalled()
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(before)
          expect((yield* Effect.scoped(flock.probe(ConfigDocument.key(file)))).status).toBe("acquired")
          expect(
            (yield* Effect.promise(() => fs.readdir(tmp.path))).some((name) => name.startsWith(".opencode-stage-")),
          ).toBe(false)
        }).pipe(
          Effect.provide(layer(tmp.path)),
          Effect.ensuring(
            Effect.sync(() => {
              intercepted.mockRestore()
              publish.mockRestore()
            }),
          ),
        )
      }),
    ),
  ),
)

it.live("C-02 interrupted prepare keeps the safe failure, lease, and previous bytes", () =>
  Effect.acquireRelease(Effect.promise(tmpdir), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(
    Effect.flatMap((tmp) =>
      Effect.gen(function* () {
        const file = path.join(tmp.path, "opencode.json")
        const previous = '{"model":"chat/model"}\n'
        yield* Effect.promise(() => fs.writeFile(file, previous))
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const open = fs.open.bind(fs)
        const owned: { handle: fs.FileHandle; writeFile: fs.FileHandle["writeFile"] }[] = []
        let calls = 0
        // Windows replaces an existing file without fs.link, so reject the temporary write before that replacement.
        const intercepted = spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await open(...args)
          if (path.basename(String(args[0])) !== "document.tmp") return handle
          calls++
          owned.push({ handle, writeFile: handle.writeFile })
          handle.writeFile = (async () => {
            await Effect.runPromise(Deferred.succeed(entered, undefined))
            await Effect.runPromise(Deferred.await(release))
            throw Object.assign(new Error("secret-token"), { code: "EIO" })
          }) as typeof handle.writeFile
          return handle
        })
        const restore = () => {
          intercepted.mockRestore()
          for (const item of owned) item.handle.writeFile = item.writeFile
        }
        const services = layer(tmp.path)
        const save = Effect.gen(function* () {
          return yield* (yield* ImageGenerationSettings.Service).update(enabled)
        }).pipe(Effect.provide(services))
        const lease = Effect.scoped(
          Effect.gen(function* () {
            const flock = yield* EffectFlock.Service
            return yield* flock.probe(ConfigDocument.key(file))
          }),
        ).pipe(Effect.provide(services))
        const exit = yield* Effect.gen(function* () {
          const fiber = yield* save.pipe(Effect.forkChild)
          yield* Deferred.await(entered)
          expect((yield* lease).status).toBe("busy")
          const during = yield* save.pipe(Effect.timeout("200 millis"), Effect.exit)
          expect(Exit.isFailure(during)).toBe(true)
          yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
          yield* Deferred.succeed(release, undefined)
          return yield* Fiber.await(fiber)
        }).pipe(Effect.ensuring(Effect.sync(restore)))
        expect(calls).toBe(1)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterrupts(exit.cause)).toBe(true)
          expect(Cause.hasFails(exit.cause)).toBe(true)
          expect(Cause.pretty(exit.cause)).toContain("not replaced")
          expect(Cause.pretty(exit.cause)).not.toContain("secret-token")
          expect(Cause.pretty(exit.cause)).not.toContain(tmp.path)
        }
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(previous)
        expect((yield* lease).status).toBe("acquired")
        expect(yield* save.pipe(Effect.timeout("20 seconds"), Effect.as(true))).toBe(true)
      }),
    ),
  ),
)

test("C-03 interrupted unknown retains publication evidence and does not replay", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "opencode.json")
  const script = `
    const fs = (await import("node:fs/promises")).default
    const path = (await import("node:path")).default
    const { Cause, Deferred, Effect, Exit, Fiber } = await import("effect")
    const { AppNodeBuilder } = await import("@opencode-ai/core/effect/app-node-builder")
    const { LayerNode } = await import("@opencode-ai/core/effect/layer-node")
    const { ConfigDocument } = await import("@opencode-ai/core/config/document")
    const { Global } = await import("@opencode-ai/core/global")
    const { ImageGenerationSettings } = await import("@opencode-ai/core/image-generation-settings")
    const { EffectFlock } = await import("@opencode-ai/core/util/effect-flock")
    const file = ${JSON.stringify(file)}
    const directory = path.dirname(file)
    const link = fs.link.bind(fs)
    const stat = fs.stat.bind(fs)
    let calls = 0
    let published = false
    const entered = Effect.runSync(Deferred.make())
    const release = Effect.runSync(Deferred.make())
    fs.link = async (...args) => {
      calls++
      await Effect.runPromise(Deferred.succeed(entered, undefined))
      await Effect.runPromise(Deferred.await(release))
      await link(...args)
      published = true
      throw new Error("secret-token")
    }
    fs.stat = async (target, ...args) => {
      if (published && String(target) === file) throw Object.assign(new Error("secret-token"), { code: "EPERM" })
      return stat(target, ...args)
    }
    const services = AppNodeBuilder.build(LayerNode.group([ImageGenerationSettings.node, EffectFlock.node]), [[Global.node, Global.layerWith({ config: directory, state: ${JSON.stringify(path.join(tmp.path, "state"))} })]])
    const lease = Effect.scoped(Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      return yield* flock.probe(ConfigDocument.key(file))
    })).pipe(Effect.provide(services))
    const save = Effect.gen(function* () {
      return yield* (yield* ImageGenerationSettings.Service).update({ enabled: true, model: "local/image", api: "openai-images" })
    }).pipe(Effect.provide(services))
    // runPromise(forkChild) closes its scope before the child reaches publication.
    const fiber = Effect.runFork(save)
    await Effect.runPromise(Deferred.await(entered))
    if ((await Effect.runPromise(lease)).status !== "busy") throw new Error("lease available during publication")
    const during = await Effect.runPromise(save.pipe(Effect.timeout("200 millis"), Effect.exit))
    if (!Exit.isFailure(during)) throw new Error("competing save entered the held lease")
    Effect.runFork(Fiber.interrupt(fiber))
    const started = Date.now()
    while (!(fiber)._interruptedCause) {
      if (Date.now() - started > 2000) throw new Error("interrupt was not observed")
      await Bun.sleep(1)
    }
    await Effect.runPromise(Deferred.succeed(release, undefined))
    const exit = await Effect.runPromise(Fiber.await(fiber))
    if (!Exit.isFailure(exit) || !Cause.hasInterrupts(exit.cause) || !Cause.hasFails(exit.cause)) throw new Error("cause incomplete")
    const rendered = Cause.pretty(exit.cause)
    const failure = Cause.squash(exit.cause)
    if (rendered.includes("secret-token") || rendered.includes("not replaced") || failure.code !== "unknown" || !String(failure.message).includes("reconciliation")) throw new Error(rendered)
    const retained = await fs.readFile(file, "utf8")
    if (calls !== 1 || !retained.includes("local/image")) throw new Error("publication evidence missing")
    if ((await Effect.runPromise(lease)).status !== "acquired") throw new Error("lease was not released")
    fs.link = link
    fs.stat = stat
    const replay = await Effect.runPromise(Effect.gen(function* () {
      return yield* (yield* ImageGenerationSettings.Service).update({ enabled: true, model: "local/replayed", api: "openai-images" }).pipe(Effect.flip)
    }).pipe(Effect.provide(services)))
    if (replay.code !== "unknown" || await fs.readFile(file, "utf8") !== retained) throw new Error("unknown publication replayed")
    console.log("C03_UNKNOWN_RETAINED")
  `
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: path.resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(stderr).toBe("")
  expect(code).toBe(0)
  expect(stdout).toContain("C03_UNKNOWN_RETAINED")
  expect(await fs.readFile(file, "utf8")).toContain("local/image")
})

for (const phase of ["initial", "locked"] as const) {
  it.live(`IMG-T08 ${phase} read failure is safe and never publishes`, () =>
    Effect.acquireRelease(Effect.promise(tmpdir), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "opencode.json")
          const blocked = path.join(tmp.path, "config.json")
          const before = '{"username":"PRIVATE-IMAGE-SENTINEL"}\n'
          yield* Effect.promise(() => fs.writeFile(file, before))
          if (phase === "initial") yield* Effect.promise(() => fs.mkdir(blocked))
          const original = ConfigDocument.withLock
          const intercepted = spyOn(ConfigDocument, "withLock").mockImplementation(((flock, target, body) =>
            original(
              flock,
              target,
              phase === "locked"
                ? Effect.andThen(
                    Effect.promise(() => fs.mkdir(blocked)),
                    body,
                  )
                : body,
            )) as typeof ConfigDocument.withLock)
          const publish = spyOn(AtomicDocument, "publish")
          yield* Effect.gen(function* () {
            const settings = yield* ImageGenerationSettings.Service
            const error = yield* settings.update(enabled).pipe(Effect.flip)
            expect(error.code).toBe("unavailable")
            expect(error.message).toBe("Could not read image generation settings.")
            expect(error.message).not.toContain(tmp.path)
            expect(error.message).not.toContain("PRIVATE-IMAGE-SENTINEL")
            expect(publish).not.toHaveBeenCalled()
            expect(intercepted).toHaveBeenCalledTimes(phase === "locked" ? 1 : 0)
            expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(before)
            expect(
              (yield* Effect.promise(() => fs.readdir(tmp.path))).some((name) => name.startsWith(".opencode-stage-")),
            ).toBe(false)
            const flock = yield* EffectFlock.Service
            expect((yield* Effect.scoped(flock.probe(ConfigDocument.key(file)))).status).toBe("acquired")
          }).pipe(
            Effect.provide(layer(tmp.path)),
            Effect.ensuring(
              Effect.sync(() => {
                intercepted.mockRestore()
                publish.mockRestore()
              }),
            ),
          )
        }),
      ),
    ),
  )
}

it.live("IMG-T08 invalid document returns safe errors without publication", () =>
  Effect.acquireRelease(Effect.promise(tmpdir), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(
    Effect.flatMap((tmp) =>
      Effect.gen(function* () {
        const file = path.join(tmp.path, "opencode.json")
        const before = '{"PRIVATE-IMAGE-SENTINEL": secret-token'
        yield* Effect.promise(() => fs.writeFile(file, before))
        const publish = spyOn(AtomicDocument, "publish")
        yield* Effect.gen(function* () {
          const settings = yield* ImageGenerationSettings.Service
          const read = yield* settings.get().pipe(Effect.flip)
          const save = yield* settings.update(enabled).pipe(Effect.flip)
          expect(read.code).toBe("unavailable")
          expect(save.code).toBe("invalid")
          for (const error of [read, save]) {
            expect(error.message).not.toContain("secret-token")
            expect(error.message).not.toContain("PRIVATE-IMAGE-SENTINEL")
            expect(error.message).not.toContain(tmp.path)
          }
          expect(publish).not.toHaveBeenCalled()
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(before)
          expect(
            (yield* Effect.promise(() => fs.readdir(tmp.path))).some((name) => name.startsWith(".opencode-stage-")),
          ).toBe(false)
          const flock = yield* EffectFlock.Service
          expect((yield* Effect.scoped(flock.probe(ConfigDocument.key(file)))).status).toBe("acquired")
        }).pipe(Effect.provide(layer(tmp.path)), Effect.ensuring(Effect.sync(() => publish.mockRestore())))
      }),
    ),
  ),
)

it.live("IMG-T02 prepare failure leaves unrelated fields unchanged and does not replay publication", () =>
  Effect.acquireRelease(Effect.promise(tmpdir), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(
    Effect.flatMap((tmp) =>
      Effect.gen(function* () {
        const file = path.join(tmp.path, "opencode.json")
        const previous = '{\n  "model": "chat/model",\n  "username": "kept"\n}\n'
        yield* Effect.promise(() => fs.writeFile(file, previous))
        const open = fs.open.bind(fs)
        const owned: { handle: fs.FileHandle; writeFile: fs.FileHandle["writeFile"] }[] = []
        let writes = 0
        const intercepted = spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await open(...args)
          if (path.basename(String(args[0])) !== "document.tmp") return handle
          owned.push({ handle, writeFile: handle.writeFile })
          const write = handle.writeFile.bind(handle)
          handle.writeFile = (async (...input: Parameters<fs.FileHandle["writeFile"]>) => {
            writes++
            if (writes === 1) throw Object.assign(new Error("secret-token"), { code: "EIO" })
            return write(...input)
          }) as typeof handle.writeFile
          return handle
        })
        const restore = () => {
          intercepted.mockRestore()
          for (const item of owned) item.handle.writeFile = item.writeFile
        }
        yield* Effect.gen(function* () {
          const failed = yield* Effect.gen(function* () {
            return yield* (yield* ImageGenerationSettings.Service).update(enabled).pipe(Effect.flip)
          }).pipe(Effect.provide(layer(tmp.path)))
          expect(failed).toBeInstanceOf(ImageGenerationSettings.Error)
          expect(failed.code).toBe("unavailable")
          expect(failed.message).toContain("not replaced")
          expect(failed.message).not.toContain("secret-token")
          expect(failed.message).not.toContain(tmp.path)
          expect(writes).toBe(1)
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(previous)
          expect(
            yield* Effect.gen(function* () {
              return yield* (yield* ImageGenerationSettings.Service).update(enabled)
            }).pipe(Effect.provide(layer(tmp.path))),
          ).toEqual(enabled)
          expect(writes).toBe(2)
          const saved = yield* Effect.promise(() => fs.readFile(file, "utf8"))
          expect(saved).toContain('"username": "kept"')
          expect(saved).toContain("local/image")
        }).pipe(Effect.ensuring(Effect.sync(restore)))
      }),
    ),
  ),
)

it.live("IMG-T03 and CL-10 committed cleanup failure recovers without a second publication", () =>
  Effect.acquireRelease(Effect.promise(tmpdir), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(
    Effect.flatMap((tmp) =>
      Effect.gen(function* () {
        const file = path.join(tmp.path, "opencode.json")
        const link = fs.link.bind(fs)
        let publications = 0
        const interceptedLink = spyOn(fs, "link").mockImplementation(async (...args) => {
          publications++
          return link(...args)
        })
        const interceptedRmdir = spyOn(fs, "rmdir").mockRejectedValueOnce(
          Object.assign(new Error("busy"), { code: "EBUSY" }),
        )
        const saved = yield* Effect.gen(function* () {
          return yield* (yield* ImageGenerationSettings.Service).update(enabled)
        }).pipe(
          Effect.provide(layer(tmp.path)),
          Effect.ensuring(
            Effect.sync(() => {
              interceptedLink.mockRestore()
              interceptedRmdir.mockRestore()
            }),
          ),
        )
        expect(saved).toEqual(enabled)
        expect(publications).toBe(1)
        const written = yield* Effect.promise(() => fs.readFile(file, "utf8"))
        expect(written).toContain("local/image")
        expect(
          (yield* Effect.promise(() => fs.readdir(tmp.path))).some((entry) => entry.startsWith(".opencode-stage-")),
        ).toBe(true)
        expect(yield* Effect.promise(() => AtomicDocument.retryCleanup())).toEqual({ remaining: 0, failed: 0 })
        expect(publications).toBe(1)
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(written)
        const remaining = yield* Effect.promise(() => fs.readdir(tmp.path))
        expect(remaining).toContain("opencode.json")
        expect(remaining.some((entry) => entry.startsWith(".opencode-stage-"))).toBe(false)
      }),
    ),
  ),
)

it.live("IMG-T10 normal save agrees with get and disk while preserving BOM CRLF and comments", () =>
  Effect.acquireRelease(Effect.promise(tmpdir), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(
    Effect.flatMap((tmp) =>
      Effect.gen(function* () {
        const file = path.join(tmp.path, "opencode.jsonc")
        yield* Effect.promise(() => fs.writeFile(file, '\uFEFF{\r\n  // keep\r\n  "model": "chat/model",\r\n}\r\n'))
        yield* Effect.gen(function* () {
          const settings = yield* ImageGenerationSettings.Service
          const saved = yield* settings.update(enabled)
          expect(saved).toEqual(enabled)
          expect(yield* settings.get()).toEqual(saved)
          const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
          expect(text.startsWith("\uFEFF")).toBe(true)
          expect(text).toContain('// keep\r\n  "model": "chat/model",')
          expect(text.replaceAll("\r\n", "")).not.toContain("\n")
          expect(text).toBe(
            ImageGenerationSettings.patchDocument('\uFEFF{\r\n  // keep\r\n  "model": "chat/model",\r\n}\r\n', saved),
          )
        }).pipe(Effect.provide(layer(tmp.path)))
      }),
    ),
  ),
)

it.live("IMG-T10 duplicate image_generation keys cannot silently discard a successful save", () =>
  Effect.acquireRelease(Effect.promise(tmpdir), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(
    Effect.flatMap((tmp) => Effect.gen(function* () {
      const file = path.join(tmp.path, "opencode.jsonc")
      const before = '{"image_generation":{"enabled":false},"image_generation":{"enabled":false}}\n'
      yield* Effect.promise(() => fs.writeFile(file, before))
      const settings = yield* ImageGenerationSettings.Service
      const saved = yield* Effect.exit(settings.update(enabled))
      if (Exit.isSuccess(saved)) throw new Error("Saved a document with duplicate image_generation keys")
      expect(Cause.findErrorOption(saved.cause)).toMatchObject({ _tag: "Some", value: { code: "invalid" } })
      expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(before)
    }).pipe(Effect.provide(layer(tmp.path)))),
  ),
)

it.live("saving settings must not silently rewrite invalid UTF-8 in an unrelated field", () =>
  Effect.acquireRelease(Effect.promise(tmpdir), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(
    Effect.flatMap((tmp) => Effect.gen(function* () {
      const file = path.join(tmp.path, "opencode.jsonc")
      const before = Buffer.concat([Buffer.from('{"model":"a'), Buffer.from([0xff]), Buffer.from('b"}\n')])
      yield* Effect.promise(() => fs.writeFile(file, before))
      const settings = yield* ImageGenerationSettings.Service
      const saved = yield* Effect.exit(settings.update(enabled))
      const after = yield* Effect.promise(() => fs.readFile(file))
      expect(after).toEqual(before)
      if (Exit.isSuccess(saved)) throw new Error("Saved a document containing invalid UTF-8")
      expect(Cause.findErrorOption(saved.cause)).toMatchObject({ _tag: "Some", value: { code: "invalid" } })
    }).pipe(Effect.provide(layer(tmp.path)))),
  ),
)

it.live("IMG-T10 a successful save must be readable even with a malformed lower-priority document", () =>
  Effect.acquireRelease(Effect.promise(tmpdir), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(
    Effect.flatMap((tmp) => Effect.gen(function* () {
      const lower = path.join(tmp.path, "opencode.json")
      const target = path.join(tmp.path, "opencode.jsonc")
      const before = '{"image_generation":{"enabled":false}}\n'
      yield* Effect.promise(() => fs.writeFile(target, before))
      const settings = yield* ImageGenerationSettings.Service
      for (const invalid of ["{bad", '{"image_generation":{"enabled":"false"}}']) {
        yield* Effect.promise(() => fs.writeFile(lower, invalid))
        const saved = yield* Effect.exit(settings.update(enabled))
        if (Exit.isSuccess(saved)) throw new Error("Saved despite unreadable lower-priority settings")
        expect(Cause.findErrorOption(saved.cause)).toMatchObject({ _tag: "Some", value: { code: "invalid" } })
        expect(yield* Effect.promise(() => fs.readFile(lower, "utf8"))).toBe(invalid)
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe(before)
      }
    }).pipe(Effect.provide(layer(tmp.path)))),
  ),
)

test("IMG-T10 a higher-priority file created while waiting is not overwritten by the stale target", () => verifyLockWorker("t10"), 30000)

it.live("IMG-T08 F29/F33 legacy image settings alias is rejected before temporary creation", () =>
  Effect.acquireRelease(Effect.promise(tmpdir), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(
    Effect.flatMap((tmp) =>
      Effect.gen(function* () {
        const canonical = path.join(tmp.path, "config"),
          alias = path.join(tmp.path, "alias")
        const before = '{"image_generation":{"enabled":false}}'
        yield* Effect.promise(async () => {
          await fs.mkdir(canonical)
          await fs.writeFile(path.join(canonical, "opencode.json"), before)
          await fs.symlink(canonical, alias, process.platform === "win32" ? "junction" : "dir")
        })
        const publish = spyOn(AtomicDocument, "publish")
        yield* Effect.gen(function* () {
          const settings = yield* ImageGenerationSettings.Service
          const error = yield* settings.update(enabled).pipe(Effect.flip)
          expect(error).toBeInstanceOf(ImageGenerationSettings.Error)
          expect(error.code).toBe("alias")
          expect(error.message).toBe("Use the canonical configuration directory to save image generation settings.")
          expect(error.message).not.toContain(tmp.path)
          expect(error.message).not.toContain(before)
          expect(publish).not.toHaveBeenCalled()
          expect(yield* settings.get()).toEqual({ enabled: false })
        }).pipe(Effect.provide(layer(alias)), Effect.ensuring(Effect.sync(() => publish.mockRestore())))
        expect(yield* Effect.promise(() => fs.readFile(path.join(canonical, "opencode.json"), "utf8"))).toBe(before)
        expect(yield* Effect.promise(() => fs.readdir(canonical))).toEqual(["opencode.json"])
        yield* Effect.gen(function* () {
          const settings = yield* ImageGenerationSettings.Service
          expect(yield* settings.update(enabled)).toEqual(enabled)
        }).pipe(Effect.provide(layer(canonical)))
      }),
    ),
  ),
)
