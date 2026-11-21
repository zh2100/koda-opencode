import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { ConfigDocument } from "@opencode-ai/core/config/document"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { LockIdentity } from "@opencode-ai/core/util/lock-identity"
import { ResourceRoot } from "@opencode-ai/core/resource-root"
import { LockProtocol } from "@opencode-ai/core/util/lock-protocol"
import { Hash } from "@opencode-ai/core/util/hash"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
const it = testEffect(Layer.empty)
for (const protocol of ["legacy", "path-identity-v1"] as const) {
  it.live(`F10/F28 shared document alias gate ${protocol}`, () =>
    Effect.acquireRelease(Effect.promise(tmpdir), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(
      Effect.flatMap((tmp) => {
        const config = path.join(tmp.path, "config"),
          alias = path.join(tmp.path, "alias"),
          state = path.join(tmp.path, "state")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(config)
            await fs.mkdir(state)
            await fs.symlink(config, alias, process.platform === "win32" ? "junction" : "dir")
            if (protocol !== "legacy")
              await fs.writeFile(LockIdentity.marker(state), JSON.stringify({ generation: LockIdentity.generation }))
          })
          const flock = yield* EffectFlock.Service,
            global = yield* Global.Service
          const file = path.join(config, "first/second/opencode.jsonc"),
            other = path.join(alias, "first/second/opencode.jsonc")
          const canonical = yield* ConfigDocument.describe(file)
          expect(ConfigDocument.key(file)).toBe(`config-document:${file}`)
          if (protocol === "legacy") {
            expect(canonical.decision.key).toBe(ConfigDocument.key(file))
            expect(Hash.fast(canonical.decision.key)).toBe(Hash.fast(ConfigDocument.key(file)))
            expect(Exit.isFailure(yield* ConfigDocument.describe(other).pipe(Effect.exit))).toBe(true)
            let wrote = false
            expect(
              Exit.isFailure(
                yield* ConfigDocument.withLock(
                  flock,
                  other,
                  Effect.sync(() => {
                    wrote = true
                  }),
                ).pipe(Effect.exit),
              ),
            ).toBe(true)
            yield* ConfigDocument.tryWithLock(
              flock,
              other,
              Effect.sync(() => {
                wrote = true
              }),
            )
            expect(wrote).toBe(false)
            expect(
              yield* Effect.promise(() =>
                fs.access(path.join(state, "locks")).then(
                  () => true,
                  () => false,
                ),
              ),
            ).toBe(false)
          } else {
            expect((yield* ConfigDocument.describe(other)).identity).toBe(canonical.identity)
            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* flock.acquire(ConfigDocument.key(file))
                const result = yield* ConfigDocument.withLock(flock, other, Effect.succeed("entered")).pipe(
                  Effect.timeoutOption("50 millis"),
                )
                expect(result._tag).toBe("None")
              }),
            )
          }
          yield* ConfigDocument.withLock(flock, file, Effect.void)
          expect(LockProtocol.resolve(ConfigDocument.key(file), global.lockContext).protocol).toBe(protocol)
          expect(
            (yield* Effect.promise(() => fs.readdir(path.join(state, "locks")))).filter((name) =>
              name.endsWith(".lock"),
            ),
          ).toEqual([])
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(LayerNode.group([EffectFlock.node, Global.node]), [
              [Global.node, Global.layerWith({ config, state })],
            ]),
          ),
        )
      }),
    ),
  )
}

test.skipIf(
  !existsSync(path.join(import.meta.dir, `../../native/dist/process-lock-${process.platform}-${process.arch}.node`)),
)("F28 existing native artifact shares canonical document identity without protocol fallback", async () => {
  await using tmp = await tmpdir()
  const selected = {
    data: path.join(tmp.path, "data"),
    config: path.join(tmp.path, "config"),
    state: path.join(tmp.path, "state"),
    cache: path.join(tmp.path, "cache"),
  }
  const home = path.join(tmp.path, "home"),
    alias = path.join(tmp.path, "alias"),
    rootId = crypto.randomUUID()
  const registration: LockProtocol.Registration = {
    schemaVersion: 1,
    rootId,
    ...selected,
    generation: "os-lock-v1",
    requireManifest: true,
    epoch: 1,
  }
  for (const dir of Object.values(selected)) await fs.mkdir(dir)
  await fs.symlink(selected.config, alias, process.platform === "win32" ? "junction" : "dir")
  ResourceRoot.remember(home, registration)
  await fs.writeFile(
    LockIdentity.marker(selected.state),
    JSON.stringify({
      schemaVersion: 1,
      generation: "os-lock-v1",
      status: "complete",
      backend: "native-file-v1",
      keyFormat: "canonical-path-v1",
      rootId,
      epoch: 1,
    }),
  )
  const global = Global.make({ home, ...selected, lockContext: ResourceRoot.select(selected, home).context })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const flock = yield* EffectFlock.Service
        const file = path.join(selected.config, "opencode.json"),
          other = path.join(alias, "opencode.json")
        const first = yield* ConfigDocument.describe(file),
          second = yield* ConfigDocument.describe(other)
        expect(first.identity).toBe(second.identity)
        expect(first.decision.backend).toBe("native-file-v1")
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* flock.acquire(ConfigDocument.key(file))
            expect(
              (yield* ConfigDocument.withLock(flock, other, Effect.void).pipe(Effect.timeoutOption("50 millis")))._tag,
            ).toBe("None")
          }),
        )
        yield* ConfigDocument.withLock(flock, other, Effect.void)
        expect((yield* ConfigDocument.describe(file)).decision.backend).toBe("native-file-v1")
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([EffectFlock.node, Global.node]), [
            [Global.node, Global.layerWith(global)],
          ]),
        ),
      ),
    ),
  )
})
