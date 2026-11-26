import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { LLMClient, LLMEvent, Model } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ImageGenerationSettings } from "@opencode-ai/core/image-generation-settings"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { node } from "@opencode-ai/core/session/runner/llm"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

describe("SessionExecutionLocal", () => {
  for (const start of ["resume", "wake"] as const) {
    it.live(
      `overlaps real runner streams and independently interrupts a ${start}-started session`,
      () =>
        Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
        ).pipe(
          Effect.flatMap((dir) =>
            Effect.gen(function* () {
              const directory = AbsolutePath.make(dir.path)
              const firstID = SessionSchema.ID.make("ses_stream_first")
              const secondID = SessionSchema.ID.make("ses_stream_second")
              const firstStarted = yield* Deferred.make<void>()
              const secondStarted = yield* Deferred.make<void>()
              const release = yield* Deferred.make<void>()
              const calls: string[] = []
              const interrupted: string[] = []
              const client = Layer.succeed(
                LLMClient.Service,
                LLMClient.Service.of({
                  prepare: () => Effect.die("unused"),
                  generate: () => Effect.die("Unexpected title generation for a named session"),
                  stream: (request) =>
                    Stream.unwrap(
                      Effect.gen(function* () {
                        const id = request.http?.headers?.["X-Session-Id"] ?? "missing"
                        calls.push(id)
                        yield* Deferred.succeed(id === firstID ? firstStarted : secondStarted, undefined)
                        yield* Deferred.await(release).pipe(
                          Effect.onInterrupt(() => Effect.sync(() => interrupted.push(id))),
                        )
                        return Stream.fromIterable([
                          LLMEvent.stepStart({ index: 0 }),
                          LLMEvent.textStart({ id: "answer" }),
                          LLMEvent.textDelta({ id: "answer", text: "[text]\nDone" }),
                          LLMEvent.textEnd({ id: "answer" }),
                          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
                          LLMEvent.finish({ reason: "stop" }),
                        ])
                      }),
                    ),
                }),
              )

              yield* Effect.gen(function* () {
                const database = yield* Database.Service
                const sessions = yield* SessionV2.Service
                const execution = yield* SessionExecution.Service
                yield* database.db
                  .insert(ProjectTable)
                  .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
                  .run()
                  .pipe(Effect.orDie)
                yield* database.db
                  .insert(SessionTable)
                  .values(
                    [firstID, secondID].map((id) => ({
                      id,
                      project_id: Project.ID.global,
                      slug: id,
                      directory,
                      title: "Concurrency regression",
                      version: "test",
                    })),
                  )
                  .run()
                  .pipe(Effect.orDie)
                yield* sessions.prompt({ sessionID: firstID, prompt: { text: "First request" }, resume: false })
                const first = start === "resume" ? yield* sessions.resume(firstID).pipe(Effect.forkChild) : undefined
                if (start === "wake") yield* execution.wake(firstID)
                yield* Deferred.await(firstStarted)
                // Joining the first Session must not block admission or execution of the second.
                const joined = yield* sessions.resume(firstID).pipe(Effect.forkChild({ startImmediately: true }))
                yield* sessions.prompt({ sessionID: secondID, prompt: { text: "Second request" } })
                yield* Deferred.await(secondStarted).pipe(Effect.timeout("10 seconds"))
                expect(calls).toEqual([firstID, secondID])
                expect(yield* execution.active).toEqual(new Set([firstID, secondID]))
                expect((yield* sessions.pending(secondID)).inputs).toEqual([])

                yield* sessions.interrupt(firstID)
                expect(interrupted).toEqual([firstID])
                expect(yield* execution.active).toEqual(new Set([secondID]))
                const exits = yield* Effect.all([...(first ? [Fiber.await(first)] : []), Fiber.await(joined)]).pipe(
                  Effect.timeout("5 seconds"),
                )
                expect(exits.every((exit) => Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))).toBe(true)

                const second = yield* sessions.resume(secondID).pipe(Effect.forkChild({ startImmediately: true }))
                yield* Deferred.succeed(release, undefined)
                yield* Fiber.join(second)
                expect(calls).toEqual([firstID, secondID])
                expect(yield* execution.active).toEqual(new Set())
                const messages = yield* sessions.messages({ sessionID: secondID, order: "asc" })
                expect(messages.at(-1)).toMatchObject({ type: "assistant", finish: "stop" })
              }).pipe(
                Effect.provide(
                  AppNodeBuilder.build(LayerNode.group([Database.node, SessionV2.node, SessionExecutionLocal.node]), [
                    [SessionExecution.node, SessionExecutionLocal.node],
                    [LayerNodePlatform.llmClient, client],
                    [
                      SessionRunnerModel.node,
                      SessionRunnerModel.layerWith(() =>
                        Effect.succeed(Model.make({ id: "test", provider: "test", route })),
                      ),
                    ],
                    [Snapshot.node, Snapshot.noopLayer],
                    [
                      ImageGenerationSettings.node,
                      Layer.mock(ImageGenerationSettings.Service, {
                        get: () => Effect.succeed({ enabled: false, automaticIllustrations: false }),
                      }),
                    ],
                  ]),
                ),
              )
            }),
          ),
        ),
      30_000,
    )
  }

  it.live(
    "runs same-directory sessions concurrently while joining and interrupting only the selected session",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            const directory = AbsolutePath.make(dir.path)
            const firstID = SessionSchema.ID.make("ses_execution_first")
            const secondID = SessionSchema.ID.make("ses_execution_second")
            const firstStarted = yield* Deferred.make<void>()
            const secondStarted = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const secondRelease = yield* Deferred.make<void>()
            const calls: SessionSchema.ID[] = []
            const interrupted: SessionSchema.ID[] = []
            const runner = Layer.effect(
              SessionRunner.Service,
              Effect.gen(function* () {
                const location = yield* Location.Service
                return SessionRunner.Service.of({
                  run: ({ sessionID }) =>
                    Effect.gen(function* () {
                      expect(location.directory).toBe(directory)
                      calls.push(sessionID)
                      yield* Deferred.succeed(sessionID === firstID ? firstStarted : secondStarted, undefined)
                      yield* Deferred.await(sessionID === firstID ? release : secondRelease)
                    }).pipe(
                      Effect.onInterrupt(() =>
                        Effect.sync(() => {
                          interrupted.push(sessionID)
                        }),
                      ),
                    ),
                })
              }),
            )

            yield* Effect.gen(function* () {
              const database = yield* Database.Service
              const store = yield* SessionStore.Service
              const locations = yield* LocationServiceMap.Service
              const execution = yield* SessionExecution.Service
              yield* database.db
                .insert(ProjectTable)
                .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
                .run()
                .pipe(Effect.orDie)
              yield* database.db
                .insert(SessionTable)
                .values(
                  [firstID, secondID].map((id) => ({
                    id,
                    project_id: Project.ID.global,
                    slug: id,
                    directory,
                    title: "test",
                    version: "test",
                  })),
                )
                .run()
                .pipe(Effect.orDie)
              // Warm the real Location services before measuring execution concurrency.
              yield* locations.contextEffect(Location.Ref.make({ directory }))
              expect((yield* store.get(firstID))?.location).toEqual((yield* store.get(secondID))?.location)

              const first = yield* execution.resume(firstID).pipe(Effect.forkChild)
              yield* Deferred.await(firstStarted)
              const joined = yield* execution.resume(firstID).pipe(Effect.forkChild({ startImmediately: true }))
              yield* execution.wake(secondID)
              yield* Effect.yieldNow

              expect(yield* Deferred.isDone(secondStarted)).toBe(true)
              expect(calls).toEqual([firstID, secondID])
              expect(yield* execution.active).toEqual(new Set([firstID, secondID]))

              yield* execution.interrupt(secondID)
              expect(interrupted).toEqual([secondID])
              expect(calls).toEqual([firstID, secondID])
              expect(yield* execution.active).toEqual(new Set([firstID]))

              yield* Deferred.succeed(release, undefined)
              yield* Fiber.join(first)
              yield* Fiber.join(joined)
              expect(calls).toEqual([firstID, secondID])
              expect(yield* execution.active).toEqual(new Set())

              yield* execution.resume(firstID)
              expect(calls).toEqual([firstID, secondID, firstID])
              expect(yield* execution.active).toEqual(new Set())
            }).pipe(
              Effect.provide(
                AppNodeBuilder.build(
                  LayerNode.group([
                    Database.node,
                    SessionStore.node,
                    LocationServiceMap.node,
                    SessionExecutionLocal.node,
                  ]),
                  [[node, runner]],
                ),
              ),
            )
          }),
        ),
      ),
    30_000,
  )
})
