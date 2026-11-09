import fs from "fs"
import os from "os"
import path from "path"
import { describe, expect, test } from "bun:test"
import { LockIdentity } from "@opencode-ai/core/util/lock-identity"
import { LockProtocol } from "@opencode-ai/core/util/lock-protocol"
import { ResourceRoot } from "@opencode-ai/core/resource-root"

const rootId = "11111111-1111-4111-8111-111111111111"

function context(root: string): LockProtocol.Context {
  return {
    data: path.join(root, "data"),
    config: path.join(root, "config"),
    state: path.join(root, "state"),
    cache: path.join(root, "cache"),
  }
}

function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value))
}

describe("lock protocol", () => {
  test("keeps an unmarked root on the original key and historical state lock directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lock-protocol-"))
    const selected = context(root)
    const key = `image-generation-settings:${selected.config}`
    const decision = LockProtocol.resolve(key, selected)
    expect(decision.protocol).toBe("legacy")
    expect(decision.backend).toBe("directory")
    expect(decision.key).toBe(key)
    expect(decision.directory).toBe(path.join(selected.state, "locks"))
    expect(LockProtocol.resolve("scheduled-task:owner", selected).directory).toBe(path.join(selected.state, "locks"))
    const requested = path.join(root, "caller-locks")
    expect(LockProtocol.resolve(key, selected, requested).directory).toBe(path.resolve(requested))
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("keeps path-identity-v1 on the normalized key and historical state lock directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lock-protocol-"))
    const selected = context(root)
    write(LockIdentity.marker(selected.state), { generation: LockIdentity.generation, status: "complete" })
    const key = `mcp-auth:${path.join(selected.data, "mcp-auth.json")}`
    const decision = LockProtocol.resolve(key, selected)
    expect(decision.protocol).toBe("path-identity-v1")
    expect(decision.backend).toBe("directory")
    expect(decision.key).toBe(LockIdentity.key(key))
    expect(decision.directory).toBe(path.join(selected.state, "locks"))
    write(LockIdentity.marker(selected.state), { generation: LockIdentity.generation })
    const omitted = LockProtocol.resolve(key, selected, path.join(selected.data, "locks"))
    expect(omitted.key).toBe(LockIdentity.key(key))
    expect(omitted.directory).toBe(path.resolve(path.join(selected.data, "locks")))
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("blocks migrating markers for path and non-path keys before creating a lock directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lock-protocol-"))
    const selected = context(root)
    write(LockIdentity.marker(selected.state), { generation: LockIdentity.generation, status: "migrating" })
    expect(() => LockProtocol.resolve("relay-auth", selected)).toThrow(/migration in progress/)
    expect(() => LockProtocol.resolve(`npm-install:${selected.cache}`, selected)).toThrow(/migration in progress/)
    expect(fs.existsSync(path.join(selected.data, "locks"))).toBe(false)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("rejects a present status with the wrong type and unknown native fields", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lock-protocol-"))
    const selected = context(root)
    const file = LockIdentity.marker(selected.state)
    for (const status of [123, true, null, { stage: "migrating" }]) {
      write(file, { generation: "os-lock-v1", status, schemaVersion: 1, backend: "native-file-v1", keyFormat: "canonical-path-v1", rootId, epoch: 1 })
      expect(() => LockProtocol.resolve("relay-secrets", selected)).toThrow(/invalid type/)
    }
    write(file, { schemaVersion: 1, generation: "os-lock-v1", status: "complete", backend: "other", keyFormat: "canonical-path-v1", rootId, epoch: 1 })
    expect(() =>
      LockProtocol.resolve("relay-secrets", {
        ...selected,
        registration: {
          schemaVersion: 1,
          rootId,
          ...selected,
          generation: "os-lock-v1",
          requireManifest: true,
          epoch: 1,
        },
        snapshot: {
          generation: "os-lock-v1",
          rootId,
          epoch: 1,
          backend: "native-file-v1",
          keyFormat: "canonical-path-v1",
          schemaVersion: 1,
        },
      }),
    ).toThrow(/unknown or contradictory/)
    write(file, { schemaVersion: 1, generation: "os-lock-v1", status: "complete", backend: "native-file-v1", keyFormat: "canonical-path-v1", rootId, epoch: "1" })
    expect(() => LockProtocol.resolve("relay-secrets", selected)).toThrow(/invalid type/)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("rejects a registered root whose completed marker disappeared", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lock-protocol-"))
    const selected = context(root)
    const registration: LockProtocol.Registration = {
      schemaVersion: 1,
      rootId,
      ...selected,
      generation: "os-lock-v1",
      requireManifest: true,
      epoch: 1,
    }
    expect(() =>
      LockProtocol.resolve("relay-auth", {
        ...selected,
        registration,
        snapshot: {
          generation: "os-lock-v1",
          rootId,
          epoch: 1,
          backend: "native-file-v1",
          keyFormat: "canonical-path-v1",
          schemaVersion: 1,
        },
      }),
    ).toThrow(/missing its completed manifest/)
    const home = path.join(root, "home")
    ResourceRoot.remember(home, registration)
    expect(() => ResourceRoot.select(selected, home)).toThrow(/missing its completed manifest/)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("shares an explicit data lock directory and keeps omitted directories on each state root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lock-protocol-"))
    const selected = context(root)
    const other = { ...selected, state: path.join(root, "other-state") }
    const dataLocks = path.join(selected.data, "locks")
    const first = LockProtocol.resolve("relay-auth", selected, dataLocks)
    const second = LockProtocol.resolve("relay-auth", other, dataLocks)
    expect(first.directory).toBe(path.resolve(dataLocks))
    expect(second.directory).toBe(path.resolve(dataLocks))
    expect(LockProtocol.resolve("relay-auth", selected).directory).toBe(path.join(selected.state, "locks"))
    expect(LockProtocol.resolve("relay-auth", other).directory).toBe(path.join(other.state, "locks"))
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("rejects a relative path in a resource registration", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lock-protocol-"))
    const home = path.join(root, "home")
    const file = path.join(home, ".opencode", "opencode-resource-root.json")
    write(file, {
      schemaVersion: 1,
      rootId,
      data: "relative-data",
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      cache: path.join(root, "cache"),
      generation: "os-lock-v1",
      requireManifest: true,
      epoch: 1,
    })
    expect(() => LockProtocol.readRegistration(file)).toThrow(/absolute/)
    fs.rmSync(root, { recursive: true, force: true })
  })
})
