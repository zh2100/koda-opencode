import { Global } from "@opencode-ai/core/global"
import { LockIdentity } from "@opencode-ai/core/util/lock-identity"
import { AtomicDocument } from "@opencode-ai/core/config/atomic-document"
import { expect, spyOn } from "bun:test"
import path from "path"
import fs from "node:fs/promises"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { ProjectConfig } from "@/config/project-write"
import { Config } from "@/config/config"
import { Auth } from "@/auth"
import { Account } from "@/account/account"
import { Npm } from "@opencode-ai/core/npm"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AuthTest } from "../fake/auth"
import { AccountTest } from "../fake/account"
import { NpmTest } from "../fake/npm"
import { InstanceWork } from "@/effect/instance-work"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { TestInstance, tmpdirScoped, provideInstanceEffect } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, EffectFlock.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [
      httpClient,
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected external HTTP")),
      ),
    ],
  ]),
)

for (const files of [
  ["opencode.json"],
  ["opencode.jsonc"],
  ["opencode.json", "opencode.jsonc"],
  [".opencode/opencode.json"],
  [".opencode/opencode.jsonc"],
  ["opencode.json", ".opencode/opencode.jsonc"],
]) {
  it.instance(`F01/F02 project write selects ${files.join(" + ")}`, () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const config = yield* Config.Service
      for (const file of files)
        yield* Effect.promise(async () => {
          await fs.mkdir(path.dirname(path.join(instance.directory, file)), { recursive: true })
          await fs.writeFile(
            path.join(instance.directory, file),
            '{\n // retained-comment\n "$schema":"https://opencode.ai/config.json", "username":"before"\n}',
          )
        })
      const legacy = path.join(instance.directory, "config.json")
      yield* Effect.promise(() => fs.writeFile(legacy, '{"username":"legacy-owned-by-another-program"}'))
      yield* config.update({ username: "after" })
      const expected = files.at(-1)!
      for (const file of files) {
        const text = yield* Effect.promise(() => fs.readFile(path.join(instance.directory, file), "utf8"))
        expect(text).toContain("retained-comment")
        expect(text).toContain(file === expected ? '"after"' : '"before"')
      }
      expect(yield* Effect.promise(() => fs.readFile(legacy, "utf8"))).toBe(
        '{"username":"legacy-owned-by-another-program"}',
      )
      const settled = yield* Effect.promise(() => InstanceWork.waitHandoffs())
      expect(settled.unrecovered).toBe(0)
      expect((yield* config.get().pipe(provideInstanceEffect(instance.directory))).username).toBe("after")
    }),
  )
}
it.instance("F03 creates current opencode.jsonc without importing config.json", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const config = yield* Config.Service
    const legacy = path.join(instance.directory, "config.json")
    yield* Effect.promise(() => fs.writeFile(legacy, '{"username":"legacy"}'))
    yield* config.update({ username: "created" })
    expect(
      JSON.parse(yield* Effect.promise(() => fs.readFile(path.join(instance.directory, "opencode.jsonc"), "utf8"))),
    ).toMatchObject({ username: "created" })
    expect(yield* Effect.promise(() => fs.readFile(legacy, "utf8"))).toBe('{"username":"legacy"}')
    const settled = yield* Effect.promise(() => InstanceWork.waitHandoffs())
    expect(settled.unrecovered).toBe(0)
    expect((yield* config.get().pipe(provideInstanceEffect(instance.directory))).username).toBe("created")
  }),
)

const setEnv = (name: string, value: string) =>
  Effect.gen(function* () {
    const before = process.env[name]
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (before === undefined) delete process.env[name]
        else process.env[name] = before
      }),
    )
    process.env[name] = value
  })
const errorCode = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  return Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
}

it.instance("F06 disabled projects fail before business files or publication", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    yield* setEnv("OPENCODE_DISABLE_PROJECT_CONFIG", "true")
    const config = yield* Config.Service
    expect(errorCode(yield* config.update({ username: "blocked" }).pipe(Effect.exit))).toMatchObject({
      code: "CONFIG_PROJECT_DISABLED",
    })
    expect(
      (yield* Effect.promise(() => fs.readdir(instance.directory))).filter((file) => /opencode|config/.test(file)),
    ).toEqual([])
  }),
)
for (const mode of ["override", "sibling", "equal"] as const) {
  it.instance(`F07 effective higher source ${mode}`, () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const file = path.join(instance.directory, "opencode.jsonc")
      const before = '{"username":"before", "provider":{"test":{"options":{"baseURL":"https://example.invalid"}}}}'
      yield* Effect.promise(() => fs.writeFile(file, before))
      yield* setEnv(
        "OPENCODE_CONFIG_CONTENT",
        JSON.stringify(
          mode === "sibling"
            ? { provider: { test: { options: { apiKey: "PRIVATE-REF-VALUE" } } } }
            : { username: mode === "equal" ? "after" : "higher" },
        ),
      )
      const config = yield* Config.Service
      const result = yield* config.update({ username: "after" }).pipe(Effect.exit)
      if (mode === "override") expect(errorCode(result)).toMatchObject({ code: "CONFIG_SOURCE_OVERRIDDEN" })
      else expect(Exit.isSuccess(result)).toBe(true)
      yield* Effect.promise(() => InstanceWork.waitHandoffs())
      const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      expect(text).not.toContain("PRIVATE-REF-VALUE")
      if (mode === "sibling") expect(text).toContain('"after"')
      else expect(text).toBe(before)
    }),
  )
}
it.instance("F09 invalid source remains byte-identical with a safe typed error", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const file = path.join(instance.directory, "opencode.json")
    const before = '{"username":"PRIVATE-INVALID-TOKEN",'
    yield* Effect.promise(() => fs.writeFile(file, before))
    const config = yield* Config.Service
    const error = errorCode(yield* config.update({ username: "after" }).pipe(Effect.exit))
    expect(error).toMatchObject({ code: "CONFIG_DOCUMENT_INVALID" })
    expect(JSON.stringify(error)).not.toContain("PRIVATE-INVALID-TOKEN")
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(before)
  }),
)
it.instance("F12 no-op has no publication or reload hooks and preserves file identity", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const file = path.join(instance.directory, "opencode.jsonc")
    const before = '{ // no-schema-no-write\n "username":"same"\n}'
    yield* Effect.promise(() => fs.writeFile(file, before))
    const stat = yield* Effect.promise(() => fs.stat(file))
    let hooks = 0
    const off = Config.onConfigReload(() => {
      hooks++
    })
    const original = AtomicDocument.publish
    let publishes = 0
    const spy = spyOn(AtomicDocument, "publish").mockImplementation((input) => {
      if (input.file === file) publishes++
      return original(input)
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        off()
        spy.mockRestore()
      }),
    )
    const config = yield* Config.Service
    yield* config.update({ username: "same" })
    yield* config.update({})
    yield* Effect.promise(() => InstanceWork.waitHandoffs())
    expect(publishes).toBe(0)
    expect(hooks).toBe(0)
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(before)
    expect((yield* Effect.promise(() => fs.stat(file))).ino).toBe(stat.ino)
  }),
)
for (const mode of [
  "reference",
  "missing",
  "template-noop",
  "template-edit",
  "template-invalid",
  "env-override-equal",
  "env-override-different",
] as const) {
  it.instance(`F11/F35 raw and effective ${mode}`, () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const file = path.join(instance.directory, "opencode.jsonc")
      const token = path.join(instance.directory, "review-token.txt")
      yield* Effect.promise(() => fs.writeFile(token, "PRIVATE-FILE-VALUE"))
      yield* setEnv("PROJECT_AUTO", mode === "template-invalid" ? "invalid-json" : "true")
      const template = mode.startsWith("template-")
      const before = template ? '{"autoupdate": {env:PROJECT_AUTO}}' : '{"username":"before"}'
      yield* Effect.promise(() => fs.writeFile(file, before))
      const higher = mode.startsWith("env-override-")
      if (higher) yield* setEnv("OPENCODE_CONFIG_CONTENT", '{"username":"{file:./review-token.txt}"}')
      const config = yield* Config.Service
      const patch = template
        ? mode === "template-noop"
          ? { autoupdate: true }
          : { username: "changed" }
        : mode === "reference"
          ? { username: "{file:./review-token.txt}" }
          : mode === "missing"
            ? { username: "{file:./missing.txt}" }
            : { username: mode === "env-override-equal" ? "PRIVATE-FILE-VALUE" : "different" }
      const result = yield* config.update(patch).pipe(Effect.exit)
      const expected =
        mode === "template-edit"
          ? "CONFIG_TEMPLATE_EDIT_UNSUPPORTED"
          : mode === "missing" || mode === "template-invalid"
            ? "CONFIG_DOCUMENT_INVALID"
            : mode === "env-override-different"
              ? "CONFIG_SOURCE_OVERRIDDEN"
              : undefined
      if (expected) {
        const error = errorCode(result)
        expect(error).toMatchObject({ code: expected })
        expect(JSON.stringify(error)).not.toContain("PRIVATE-FILE-VALUE")
      } else expect(Exit.isSuccess(result)).toBe(true)
      yield* Effect.promise(() => InstanceWork.waitHandoffs())
      const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      expect(text).not.toContain("PRIVATE-FILE-VALUE")
      if (mode === "reference") {
        expect(text).toContain("{file:./review-token.txt}")
        expect((yield* config.get().pipe(provideInstanceEffect(instance.directory))).username).toBe(
          "PRIVATE-FILE-VALUE",
        )
      } else expect(text).toBe(before)
    }),
  )
}
it.instance("F08 duplicate physical source participates at every actual merge position", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const file = path.join(instance.directory, "opencode.json")
    yield* Effect.promise(() => fs.writeFile(file, '{"username":"before"}'))
    yield* setEnv("OPENCODE_CONFIG", file)
    const config = yield* Config.Service
    yield* config.update({ username: "after" })
    yield* Effect.promise(() => InstanceWork.waitHandoffs())
    expect((yield* config.get().pipe(provideInstanceEffect(instance.directory))).username).toBe("after")
  }),
)

it.instance("F12 instructions clears owned entries and retains inherited concatenation", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const file = path.join(instance.directory, "opencode.jsonc")
    yield* Effect.promise(() => fs.writeFile(file, '{"instructions":["owned.md"]}'))
    yield* setEnv("OPENCODE_CONFIG_CONTENT", '{"instructions":["higher.md"]}')
    const config = yield* Config.Service
    yield* config.update({ instructions: [] })
    yield* Effect.promise(() => InstanceWork.waitHandoffs())
    expect(JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8"))).instructions).toEqual([])
    expect((yield* config.get().pipe(provideInstanceEffect(instance.directory))).instructions).toEqual(["higher.md"])
  }),
)
it.instance("F07 higher discovered agent fields cannot be silently overridden by project JSON", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const file = path.join(instance.directory, "opencode.jsonc")
    const directory = path.join(instance.directory, ".opencode/agents")
    yield* Effect.promise(async () => {
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(path.join(directory, "review.md"), "---\ndescription: existing\n---\nhigher prompt")
      await fs.writeFile(file, "{}")
    })
    const config = yield* Config.Service
    const result = yield* config.update({ agent: { review: { prompt: "requested prompt" } } }).pipe(Effect.exit)
    expect(errorCode(result)).toMatchObject({ code: "CONFIG_SOURCE_OVERRIDDEN" })
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("{}")
  }),
)

for (const stage of ["selection-wait", "decision", "baseline", "validated"] as const) {
  it.instance(`F14/F32 local change at ${stage}`, () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const file = path.join(instance.directory, "opencode.jsonc")
      if (stage !== "selection-wait") yield* Effect.promise(() => fs.writeFile(file, '{"username":"before"}'))
      let injected = false
      const stop = ProjectConfig.observe(instance.directory, async (phase) => {
        if (phase !== stage || injected) return
        injected = true
        if (stage === "decision") {
          const higher = path.join(instance.directory, ".opencode/opencode.jsonc")
          await fs.mkdir(path.dirname(higher), { recursive: true })
          await fs.writeFile(higher, '{"username":"external"}')
        } else await fs.writeFile(file, '{"username":"external"}')
      })
      yield* Effect.addFinalizer(() => Effect.sync(stop))
      const config = yield* Config.Service
      const result = yield* config.update({ username: "after" }).pipe(Effect.exit)
      if (stage === "selection-wait") expect(Exit.isSuccess(result)).toBe(true)
      else expect(errorCode(result)).toMatchObject({ code: "CONFIG_SOURCE_CHANGED" })
      yield* Effect.promise(() => InstanceWork.waitHandoffs())
      expect(JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8"))).username).toBe(
        stage === "selection-wait" ? "after" : stage === "decision" ? "before" : "external",
      )
      expect(injected).toBe(true)
    }),
  )
}
for (const dependency of ["file", "env", "new-reference"]) {
  it.instance(`F35 dependency ${dependency} changes after candidate validation`, () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const file = path.join(instance.directory, "opencode.jsonc"),
        token = path.join(instance.directory, "private.txt")
      const before =
        dependency === "file"
          ? '{"username":"{file:./private.txt}"}'
          : dependency === "env"
            ? '{"username":"{env:PROJECT_REF}"}'
            : "{}"
      yield* setEnv("PROJECT_REF", "before")
      yield* Effect.promise(async () => {
        await fs.writeFile(file, before)
        await fs.writeFile(token, "PRIVATE-BEFORE")
      })
      const stop = ProjectConfig.observe(instance.directory, async (phase) => {
        if (phase !== "validated") return
        if (dependency === "env") process.env.PROJECT_REF = "PRIVATE-AFTER"
        else await fs.writeFile(token, "PRIVATE-AFTER")
      })
      yield* Effect.addFinalizer(() => Effect.sync(stop))
      const config = yield* Config.Service
      const patch = dependency === "new-reference" ? { username: "{file:./private.txt}" } : { model: "local/chat" }
      const error = errorCode(yield* config.update(patch).pipe(Effect.exit))
      expect(error).toMatchObject({ code: "CONFIG_SOURCE_CHANGED" })
      expect(JSON.stringify(error)).not.toContain("PRIVATE-")
      expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(before)
    }),
  )
}
it.instance("F04 two accepted first saves use latest local baseline and retain both patches", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const config = yield* Config.Service
    const secondReady = Promise.withResolvers<void>(),
      releaseSecond = Promise.withResolvers<void>(),
      releaseHandoff = Promise.withResolvers<void>()
    let selection = 0
    const stop = ProjectConfig.observe(instance.directory, async (phase) => {
      if (phase === "selection-wait" && ++selection === 2) {
        secondReady.resolve()
        await releaseSecond.promise
      }
      if (phase === "handoff") await releaseHandoff.promise
    })
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        releaseSecond.resolve()
        releaseHandoff.resolve()
        stop()
        await InstanceWork.waitHandoffs()
      }),
    )
    // Keep the first request at selection until P of the second request exists.
    const firstGate = Promise.withResolvers<void>(),
      firstReady = Promise.withResolvers<void>()
    const stopFirst = ProjectConfig.observe(instance.directory, async (phase) => {
      if (phase === "selection-wait" && selection === 1) {
        firstReady.resolve()
        await firstGate.promise
      }
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        firstGate.resolve()
        stopFirst()
      }),
    )
    const first = yield* config.update({ username: "first" }).pipe(Effect.forkScoped)
    yield* Effect.promise(() => firstReady.promise)
    const second = yield* config.update({ model: "local/second" }).pipe(Effect.forkScoped)
    yield* Effect.promise(() => secondReady.promise)
    firstGate.resolve()
    yield* Fiber.join(first)
    releaseSecond.resolve()
    yield* Fiber.join(second)
    releaseHandoff.resolve()
    yield* Effect.promise(() => InstanceWork.waitHandoffs())
    expect(
      JSON.parse(yield* Effect.promise(() => fs.readFile(path.join(instance.directory, "opencode.jsonc"), "utf8"))),
    ).toMatchObject({ username: "first", model: "local/second" })
    expect(yield* config.get().pipe(provideInstanceEffect(instance.directory))).toMatchObject({
      username: "first",
      model: "local/second",
    })
  }),
)

for (const protocol of ["legacy", "path-identity-v1"]) {
  it.instance(`F10/F27/F28 local physical duplicates under ${protocol}`, () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const marker = LockIdentity.marker(Global.Path.state)
      const previous = yield* Effect.promise(() => fs.readFile(marker).catch(() => undefined))
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          if (previous) await fs.writeFile(marker, previous)
          else await fs.rm(marker, { force: true })
        }),
      )
      const file = path.join(instance.directory, "opencode.jsonc"),
        before = '{"username":"before","instructions":["one.md"]}'
      yield* Effect.promise(async () => {
        if (protocol !== "legacy") await fs.writeFile(marker, JSON.stringify({ generation: LockIdentity.generation }))
        else await fs.rm(marker, { force: true })
        await fs.writeFile(file, before)
        await fs.symlink(
          instance.directory,
          path.join(instance.directory, ".opencode"),
          process.platform === "win32" ? "junction" : "dir",
        )
      })
      let documents = 0
      const stop = ProjectConfig.observe(instance.directory, (phase) => {
        if (phase === "document-wait") documents++
      })
      yield* Effect.addFinalizer(() => Effect.sync(stop))
      const config = yield* Config.Service
      const result = yield* config.update({ username: "after" }).pipe(Effect.exit)
      if (protocol === "legacy") {
        expect(errorCode(result)).toMatchObject({ code: "CONFIG_PATH_ALIAS_UNSUPPORTED" })
        expect(documents).toBe(0)
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(before)
        return
      }
      expect(Exit.isSuccess(result)).toBe(true)
      expect(documents).toBe(2)
      yield* Effect.promise(() => InstanceWork.waitHandoffs())
      expect(yield* config.get().pipe(provideInstanceEffect(instance.directory))).toMatchObject({
        username: "after",
        instructions: ["one.md"],
      })
    }),
  )
}

it.instance("F35 protected target self reference is refused without publishing expanded old bytes", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance,
      config = yield* Config.Service
    const file = path.join(instance.directory, "opencode.jsonc"),
      before = '{"username":"before"}'
    yield* Effect.promise(() => fs.writeFile(file, before))
    expect(errorCode(yield* config.update({ username: "{file:./opencode.jsonc}" }).pipe(Effect.exit))).toMatchObject({
      code: "CONFIG_PATCH_INVALID",
    })
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(before)
  }),
)
it.instance("F35 valid uneditable inherited template remains readable while another target is edited", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance,
      config = yield* Config.Service
    yield* setEnv("PROJECT_TEMPLATE", "true")
    const base = path.join(instance.directory, "opencode.json"),
      target = path.join(instance.directory, "opencode.jsonc")
    const raw = '{"autoupdate": {env:PROJECT_TEMPLATE}}'
    yield* Effect.promise(async () => {
      await fs.writeFile(base, raw)
      await fs.writeFile(target, "{}")
    })
    yield* config.update({ username: "after" })
    yield* Effect.promise(() => InstanceWork.waitHandoffs())
    expect(yield* Effect.promise(() => fs.readFile(base, "utf8"))).toBe(raw)
    expect(yield* config.get().pipe(provideInstanceEffect(instance.directory))).toMatchObject({
      username: "after",
      autoupdate: true,
    })
  }),
)
for (const overwritten of [false, true]) {
  it.instance(`F05/F35 same reference token keeps each source directory (${overwritten})`, () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance,
        config = yield* Config.Service
      const nested = path.join(instance.directory, ".opencode"),
        target = path.join(nested, "opencode.jsonc")
      yield* Effect.promise(async () => {
        await fs.mkdir(nested)
        await fs.writeFile(path.join(instance.directory, "opencode.json"), '{"username":"{file:./token.txt}"}')
        await fs.writeFile(path.join(instance.directory, "token.txt"), "PRIVATE-BASE")
        await fs.writeFile(path.join(nested, "token.txt"), "PRIVATE-LOCAL")
        await fs.writeFile(target, '{"username":"{file:./token.txt}"}')
      })
      if (overwritten) yield* setEnv("OPENCODE_CONFIG_CONTENT", '{"username":"higher"}')
      const result = yield* config.update({ username: "{file:./token.txt}", model: "local/chat" }).pipe(Effect.exit)
      if (overwritten) expect(errorCode(result)).toMatchObject({ code: "CONFIG_SOURCE_OVERRIDDEN" })
      else {
        expect(Exit.isSuccess(result)).toBe(true)
        yield* Effect.promise(() => InstanceWork.waitHandoffs())
        expect((yield* config.get().pipe(provideInstanceEffect(instance.directory))).username).toBe("PRIVATE-LOCAL")
      }
      const written = yield* Effect.promise(() => fs.readFile(target, "utf8"))
      expect(written).not.toContain("PRIVATE-")
      expect(written).toContain("{file:./token.txt}")
    }),
  )
}

for (const source of ["explicit", "custom", "managed"])
  for (const mode of ["overridden", "sibling"]) {
    it.instance(`F05/F07 external ${source} source with ${mode} fields`, () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance,
          config = yield* Config.Service,
          external = yield* tmpdirScoped()
        const file = path.join(instance.directory, "opencode.jsonc"),
          outer = path.join(external, "opencode.jsonc")
        const before = '{"username":"before"}',
          other = JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            ...(mode === "overridden" ? { username: "higher" } : { model: "local/inherited" }),
          })
        yield* Effect.promise(async () => {
          await fs.writeFile(file, before)
          await fs.writeFile(outer, other)
        })
        yield* setEnv(
          source === "explicit"
            ? "OPENCODE_CONFIG"
            : source === "custom"
              ? "OPENCODE_CONFIG_DIR"
              : "OPENCODE_TEST_MANAGED_CONFIG_DIR",
          source === "explicit" ? outer : external,
        )
        const result = yield* config.update({ username: "after" }).pipe(Effect.exit)
        expect(yield* Effect.promise(() => fs.readFile(outer, "utf8"))).toBe(other)
        const conflict = mode === "overridden" && source !== "explicit"
        if (conflict) expect(errorCode(result)).toMatchObject({ code: "CONFIG_SOURCE_OVERRIDDEN" })
        else {
          expect(Exit.isSuccess(result)).toBe(true)
          yield* Effect.promise(() => InstanceWork.waitHandoffs())
          expect((yield* config.get().pipe(provideInstanceEffect(instance.directory))).username).toBe("after")
        }
        expect(yield* Effect.promise(() => fs.readFile(outer, "utf8"))).toBe(other)
        expect(JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8"))).username).toBe(
          conflict ? "before" : "after",
        )
      }),
    )
  }

for (const mode of ["overridden", "sibling"]) {
  it.instance(`F05 home .opencode source with ${mode} fields`, () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance,
        config = yield* Config.Service,
        home = yield* tmpdirScoped()
      const file = path.join(instance.directory, "opencode.jsonc"),
        external = path.join(home, ".opencode/opencode.jsonc")
      const before = '{"username":"before"}',
        inherited = JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          ...(mode === "overridden" ? { username: "higher" } : { model: "local/inherited" }),
        })
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(external))
        await fs.writeFile(external, inherited)
        await fs.writeFile(file, before)
      })
      yield* setEnv("OPENCODE_TEST_HOME", home)
      const result = yield* config.update({ username: "after" }).pipe(Effect.exit)
      if (mode === "overridden") expect(errorCode(result)).toMatchObject({ code: "CONFIG_SOURCE_OVERRIDDEN" })
      else expect(Exit.isSuccess(result)).toBe(true)
      expect(yield* Effect.promise(() => fs.readFile(external, "utf8"))).toBe(inherited)
      yield* Effect.promise(() => InstanceWork.waitHandoffs())
      expect(JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8"))).username).toBe(
        mode === "overridden" ? "before" : "after",
      )
      expect((yield* config.get().pipe(provideInstanceEffect(instance.directory))).username).toBe(
        mode === "overridden" ? "higher" : "after",
      )
      expect(yield* Effect.promise(() => fs.readFile(external, "utf8"))).toBe(inherited)
    }),
  )
}

it.instance(
  "F03 parent-only config is inherited but first save creates in current directory",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance,
        config = yield* Config.Service
      const child = path.join(instance.directory, "child"),
        parent = path.join(instance.directory, "opencode.json")
      const before = '{"$schema":"https://opencode.ai/config.json","model":"local/parent"}'
      yield* Effect.promise(async () => {
        await fs.mkdir(child)
        await fs.writeFile(parent, before)
      })
      yield* config.update({ username: "child" }).pipe(provideInstanceEffect(child))
      yield* Effect.promise(() => InstanceWork.waitHandoffs())
      expect(yield* Effect.promise(() => fs.readFile(parent, "utf8"))).toBe(before)
      expect(
        JSON.parse(yield* Effect.promise(() => fs.readFile(path.join(child, "opencode.jsonc"), "utf8"))),
      ).toMatchObject({ username: "child" })
      expect(yield* config.get().pipe(provideInstanceEffect(child))).toMatchObject({
        username: "child",
        model: "local/parent",
      })
    }),
  { git: true },
)

for (const phase of ["decision", "validated"] as const)
  for (const change of ["delete", "replace-parent"] as const) {
    it.instance(`F14 ${change} after ${phase} rejects frozen target`, () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance,
          config = yield* Config.Service
        const parent = path.join(instance.directory, ".opencode"),
          file = path.join(parent, "opencode.jsonc"),
          retired = path.join(instance.directory, "retired-config")
        const before = '{"username":"before"}'
        yield* Effect.promise(async () => {
          await fs.mkdir(parent)
          await fs.writeFile(file, before)
        })
        const stop = ProjectConfig.observe(instance.directory, async (step) => {
          if (step !== phase) return
          if (change === "delete") {
            await fs.unlink(file)
            return
          }
          await fs.rename(parent, retired)
          await fs.mkdir(parent)
          await fs.writeFile(file, before)
        })
        yield* Effect.addFinalizer(() => Effect.sync(stop))
        expect(errorCode(yield* config.update({ username: "after" }).pipe(Effect.exit))).toMatchObject({
          code: "CONFIG_SOURCE_CHANGED",
        })
        if (change === "delete")
          expect(
            yield* Effect.promise(() =>
              fs.stat(file).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false)
        else {
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(before)
          expect(yield* Effect.promise(() => fs.readFile(path.join(retired, "opencode.jsonc"), "utf8"))).toBe(before)
        }
        expect(
          yield* Effect.promise(() =>
            fs.stat(path.join(instance.directory, "opencode.jsonc")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
      }),
    )
  }

it.instance("F04 owner closes during preparation and the frozen request cannot publish into its successor", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance,
      config = yield* Config.Service,
      ctx = yield* InstanceState.context
    const file = path.join(instance.directory, "opencode.jsonc"),
      before = '{"username":"before"}'
    yield* Effect.promise(() => fs.writeFile(file, before))
    const waiting = Promise.withResolvers<void>()
    const stop = ProjectConfig.observe(instance.directory, (phase) => {
      if (phase === "selection-wait") waiting.resolve()
    })
    yield* Effect.addFinalizer(() => Effect.sync(stop))
    const flock = yield* EffectFlock.Service
    yield* flock.acquire(`config-project-selection:${instance.directory}`)
    const running = yield* config.update({ username: "must-not-publish" }).pipe(Effect.forkScoped)
    yield* Effect.promise(() => waiting.promise)
    yield* Effect.promise(() => InstanceWork.drain(ctx))
    expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true)
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(before)
    expect(InstanceWork.owner(ctx).tasks.size).toBe(0)
  }),
)

it.instance("F21 one owner refresh leaves another directory and workspace untouched", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance,
      config = yield* Config.Service,
      other = yield* tmpdirScoped({ git: true, config: { username: "other" } })
    const file = path.join(instance.directory, "opencode.jsonc"),
      otherFile = path.join(other, "opencode.json")
    yield* Effect.promise(() => fs.writeFile(file, '{"username":"before"}'))
    const before = yield* Effect.promise(() => fs.readFile(otherFile, "utf8"))
    const readOther = Effect.gen(function* () {
      return { value: yield* config.get(), ctx: yield* InstanceRef, workspace: yield* WorkspaceRef }
    }).pipe(provideInstanceEffect(other))
    const previous = yield* readOther
    yield* config.update({ username: "after" })
    yield* Effect.promise(() => InstanceWork.waitHandoffs())
    const next = yield* readOther
    expect(next.ctx).toBe(previous.ctx)
    expect(next.value).toBe(previous.value)
    expect(next.workspace).toBe(previous.workspace)
    expect(InstanceWork.owner(next.ctx!).phase).toBe("accepting")
    expect(yield* Effect.promise(() => fs.readFile(otherFile, "utf8"))).toBe(before)
    expect((yield* config.get().pipe(provideInstanceEffect(instance.directory))).username).toBe("after")
  }),
)

it.instance(
  "F12 project image replacement, array replacement, nested and empty-object patches preserve semantics",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance,
        config = yield* Config.Service
      const file = path.join(instance.directory, "opencode.jsonc")
      yield* Effect.promise(() =>
        fs.writeFile(
          file,
          JSON.stringify({
            image_generation: { enabled: true, model: "local/image", api: "openai-images" },
            disabled_providers: ["old"],
            provider: { local: { options: { retained: true } } },
          }),
        ),
      )
      yield* config.update({
        image_generation: { enabled: false },
        disabled_providers: ["new"],
        provider: { local: { options: { added: true } } },
      })
      yield* Effect.promise(() => InstanceWork.waitHandoffs())
      yield* config
        .update({ provider: { local: { options: {} } }, agent: {}, model: "local/final" })
        .pipe(provideInstanceEffect(instance.directory))
      yield* Effect.promise(() => InstanceWork.waitHandoffs())
      const written = JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8")))
      expect(written.image_generation).toEqual({ enabled: false })
      expect(written.disabled_providers).toEqual(["new"])
      expect(written.provider.local.options).toEqual({ retained: true, added: true })
      expect(written.agent).toEqual({})
      expect(yield* config.get().pipe(provideInstanceEffect(instance.directory))).toMatchObject(written)
    }),
)
