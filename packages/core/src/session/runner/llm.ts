import { ToolErrorProjection, ToolFailure } from "@opencode-ai/llm"
import { sessionPermissions } from "../../session-policy"
import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  isContextOverflowFailure,
  type ProviderErrorEvent,
} from "@opencode-ai/llm"
import { Cause, DateTime, Effect, FiberSet, Layer, Option, Semaphore, Stream } from "effect"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { ImageGenerationSettings } from "../../image-generation-settings"
import { illustrate, illustrationInstruction, inventoryInstruction } from "./illustration-plan"
import { inventoryPattern } from "../../tool/illustration-capability"
import { reserveImage } from "../image-attempt"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { PermissionV2 } from "../../permission"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { SkillGuidance } from "../../skill/guidance"
import { ReferenceGuidance } from "../../reference/guidance"
import { ToolRegistry } from "../../tool/registry"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionContextEpoch } from "../context-epoch"
import { SessionCompaction } from "../compaction"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionTitle } from "../title"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { createLLMEventPublisher } from "./publish-llm-event"
import { deliverImage, imageResponseFrame, imageRouting, imageRoutingInstruction } from "./image-intent"
import { normalizeDocumentAttachments, toLLMMessages } from "./to-llm-message"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { Snapshot } from "../../snapshot"
import { FSUtil } from "../../fs-util"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"

/**
 * Runs one durable coding-agent Session until it settles.
 *
 * Keep this as orchestration over smaller collaborators rather than rebuilding the legacy
 * `SessionPrompt` monolith. Implement the unchecked items in small reviewed slices:
 *
 * - Session ownership and controls
 *   - [x] Coordinate one local active drain per Session; explicit resumes join and prompt wakeups coalesce.
 *   - [ ] Replace local ownership with durable multi-node ownership when clustered.
 *   - [ ] Mark busy, retrying, idle, interrupted, or terminal-failure status durably.
 *   - [ ] Honor interruption and reject stale work after runtime attachment replacement.
 *   - [x] Honor optional agent step limits.
 *   - [ ] Bound provider retries and repeated identical tool calls.
 *
 * - Runtime context assembly
 *   - Track V1 runtime-context parity canonically in `specs/v2/session.md`.
 *
 * - One provider turn
 *   - [x] Translate every projected V2 Session message variant into canonical
 *     `@opencode-ai/llm` messages.
 *   - [ ] Resolve policy-filtered built-in, MCP, plugin, and structured-output tool definitions.
 *   - [x] Stream exactly one `llm.stream(request)` provider turn.
 *   - [x] Persist assistant text and usage events incrementally as they arrive.
 *   - [ ] Persist snapshots, patches, and retry notices incrementally as they arrive.
 *   - [x] Persist reasoning, provider errors, and tool-call events incrementally as they arrive.
 *
 * - Tool settlement and continuation
 *   - [x] Durably record each tool call before side effects begin.
 *   - [x] Authorize and execute recorded local calls through a core-owned registry hook.
 *   - [x] Persist typed success, failure, and provider-executed tool outcomes.
 *   - [x] Start each recorded local call eagerly and await all settlements before continuation.
 *   - [ ] Add scoped runtime context, progress updates, attachment normalization,
 *     plugins, and cancellation settlement.
 *   - [x] Reload projected history and start the next explicit provider turn after local tool results.
 *   - [x] Continue for durable user steering accepted during an active provider turn.
 *   - [ ] Continue for compaction or another continuation condition when required.
 *
 * - Post-run maintenance
 *   - [ ] Settle final status and expose durable output events to replayable consumers.
 *   - [ ] Coalesce streamed deltas and add covering projected-history indexes.
 *   - [ ] Update title, summaries, compaction state, and cleanup in bounded background work.
 *
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
 * Durable continuation recovery remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and an
 * explicit loop starts the next provider turn after local settlement. Configured agent step limits bound the loop.
 */

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const tools = yield* ToolRegistry.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const config = yield* Config.Service
    const settings = yield* ImageGenerationSettings.Service
    const questions = yield* QuestionV2.Service
    const snapshots = yield* Snapshot.Service
    const fs = yield* FSUtil.Service
    const db = (yield* Database.Service).db
    const titleScope = yield* Effect.scope
    const title = SessionTitle.make(db, events, llm)
    const compaction = SessionCompaction.make({ events, llm, config: yield* config.entries() })
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
    })
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* getContext(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
          const projected = ToolErrorProjection.project({
            id: tool.id,
            name: tool.name,
            executed: tool.provider?.executed === true,
            callMetadata: tool.provider?.metadata,
          })
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID,
            timestamp: yield* DateTime.now,
            assistantMessageID: message.id,
            callID: tool.id,
            error: { type: "unknown", message: "Tool execution interrupted" },
            result: projected.result,
            provider: {
              executed: tool.provider?.executed === true,
              ...(projected.metadata === undefined ? {} : { metadata: projected.metadata }),
            },
          })
        }
      }
    })

    const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
      Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))

    // Match V1: declining a user prompt halts the loop instead of becoming model-facing tool output.
    const isUserDeclined = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some(
        (reason) =>
          Cause.isDieReason(reason) &&
          (reason.defect instanceof PermissionV2.DeclinedError || reason.defect instanceof QuestionV2.RejectedError),
      )

    type TurnTransition =
      // Automatic compaction completed; rebuild the request from compacted history.
      | { readonly _tag: "ContinueAfterCompaction"; readonly step: number }
      // Overflow compaction completed; rebuild once through the path without overflow recovery.
      | { readonly _tag: "ContinueAfterOverflowCompaction"; readonly step: number }

    class TurnTransitionError extends Error {
      constructor(readonly transition: TurnTransition) {
        super()
      }
    }

    // A transition is internal control flow only when it is the entire cause.
    // Catching the first defect alone would discard an accompanying interrupt or cleanup failure.
    const turnTransition = (cause: Cause.Cause<unknown>) => {
      const reason = cause.reasons[0]
      return cause.reasons.length === 1 &&
        reason &&
        Cause.isDieReason(reason) &&
        reason.defect instanceof TurnTransitionError
        ? reason.defect.transition
        : undefined
    }

    const continueAfterCompaction = (step: number) => new TurnTransitionError({ _tag: "ContinueAfterCompaction", step })
    const continueAfterOverflowCompaction = (step: number) =>
      new TurnTransitionError({ _tag: "ContinueAfterOverflowCompaction", step })

    const languageInstruction = (messages: readonly SessionMessage.Message[]) => {
      const text = [...messages].reverse().find((message) => message.type === "user" && message.text.trim())
      if (!text || text.type !== "user") {
        return "Reply in the same natural language as the user's latest message. Do not change languages unless the user asks you to."
      }
      const value = text.text
      if (/\p{Script=Han}/u.test(value)) {
        return "Reply entirely in the same Chinese variety used by the user, preserving code, identifiers, paths, and quoted text exactly. Do not switch to another language unless the user asks you to."
      }
      if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(value)) {
        return "Reply entirely in Japanese, preserving code, identifiers, paths, and quoted text exactly. Do not switch languages unless the user asks you to."
      }
      if (/\p{Script=Hangul}/u.test(value)) {
        return "Reply entirely in Korean, preserving code, identifiers, paths, and quoted text exactly. Do not switch languages unless the user asks you to."
      }
      if (/\p{Script=Cyrillic}/u.test(value)) {
        return "Reply entirely in the same Cyrillic-based language used by the user, preserving code, identifiers, paths, and quoted text exactly. Do not switch languages unless the user asks you to."
      }
      if (/\p{Script=Arabic}/u.test(value)) {
        return "Reply entirely in the same Arabic-script language used by the user, preserving code, identifiers, paths, and quoted text exactly. Do not switch languages unless the user asks you to."
      }
      if (/\p{Script=Hebrew}/u.test(value)) {
        return "Reply entirely in Hebrew, preserving code, identifiers, paths, and quoted text exactly. Do not switch languages unless the user asks you to."
      }
      return "Reply entirely in the same language as the user's latest message, preserving code, identifiers, paths, and quoted text exactly. Do not switch languages unless the user asks you to."
    }

    const loadSystemContext = (agent: AgentV2.Selection) =>
      Effect.all([systemContext.load(), skillGuidance.load(agent), referenceGuidance.load()], {
        concurrency: "unbounded",
      }).pipe(Effect.map(SystemContext.combine))

    type Inventory = { user: SessionMessage.ID; empty: boolean }
    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      inventory?: Inventory,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
    ) {
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      const agent = yield* agents.select(session.agent)
      const initialized = yield* SessionContextEpoch.initialize(db, loadSystemContext(agent), session.id)
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      let needsContinuation = false
      let inspectedMaterials = false
      let toolCalls = 0
      let emptyInventory = false
      const promotedMessages: SessionMessage.ID[] = []
      let currentStep = step
      if (promotion) {
        const cutoff = yield* EventV2.latestSequence(db, session.id)
        let promoted = 0
        if (promotion === "steer")
          promoted = yield* SessionInput.promoteSteers(db, events, session.id, cutoff, promotedMessages)
        if (promotion === "queue") {
          promoted += Number(yield* SessionInput.promoteNextQueued(db, events, session.id, promotedMessages))
          promoted += yield* SessionInput.promoteSteers(db, events, session.id, cutoff, promotedMessages)
        }
        if (promoted > 0) currentStep = 1
      }
      const system =
        initialized ?? (yield* SessionContextEpoch.prepare(db, events, loadSystemContext(agent), session.id))
      const model = yield* models.resolve(session).pipe(
        Effect.tapError(() => {
          if (!session.model) return Effect.void
          // Resolution happens before the provider publisher exists. Persist a safe terminal
          // failure here so an admitted prompt cannot remain visually unanswered forever.
          return createLLMEventPublisher(events, {
            sessionID: session.id,
            agent: agent.id,
            model: session.model,
          }).failAssistant(
            "The selected conversation model could not be initialized. Check its availability and provider connection. No provider request was sent for this turn.",
          )
        }),
      )
      if (promotedMessages.length > 0)
        yield* title({
          session,
          promoted: promotedMessages,
          model,
          resolveModel: Effect.gen(function* () {
            const configured = yield* agents.get(AgentV2.ID.make("title"))
            return configured?.model
              ? yield* models
                  .resolve({ ...session, model: configured.model })
                  .pipe(Effect.catch(() => Effect.succeed(model)))
              : model
          }),
        }).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            () => Effect.logWarning("Session title generation failed"),
          ),
          Effect.forkIn(titleScope),
        )
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      const context = entries.map((entry) => entry.message)
      const latest = context.at(-1)
      // An explicit resume is not a new image request or an answer to a clarification.
      if (
        !promotedMessages.length &&
        latest?.type === "assistant" &&
        latest.content.some(
          (part) =>
            (part.type === "tool" && part.id.startsWith("image-msg_")) ||
            (part.type === "text" && part.id.startsWith("image-intent-")),
        )
      )
        return { needsContinuation: false, step: currentStep }
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const toolMaterialization = isLastStep
        ? undefined
        : yield* tools.materialize(sessionPermissions(session.approvalMode, agent.info?.permissions ?? []))
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      const routeImage =
        latest?.type === "user" && promotedMessages.length === 1 && promotedMessages[0] === latest.id
          ? imageRouting(context, latest)
          : undefined
      // Inventory tools can run before planning. Carry only the active drain's admitted
      // task identity; explicit resumes, batched steers and post-crash runs cannot reopen it.
      const task = promotedMessages.length
        ? routeImage && latest?.type === "user"
          ? latest
          : undefined
        : context.find((m) => m.type === "user" && m.id === inventory?.user)
      const planning = task?.type === "user" ? task : undefined
      const publication = {
        sessionID: session.id,
        agent: agent.id,
        model: {
          id: ModelV2.ID.make(model.id),
          providerID: ProviderV2.ID.make(model.provider),
          ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
        },
      }
      const normalizedContext = yield* normalizeDocumentAttachments(context, (filepath) =>
        fs.readFile(filepath).pipe(Effect.catch(() => Effect.succeed(undefined))),
      )
      const request = LLM.request({
        model,
        http: {
          headers: {
            "x-session-affinity": session.id,
            "X-Session-Id": session.id,
            ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
          },
        },
        providerOptions: { openai: { promptCacheKey, imageGeneration: false } },
        system: [
          agent.info?.system,
          system.baseline,
          routeImage || planning ? imageRoutingInstruction : undefined,
          routeImage?.instruction,
          planning ? illustrationInstruction : undefined,
          planning ? inventoryInstruction : undefined,
          languageInstruction(context),
        ]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .map(SystemPart.make),
        messages: [
          ...toLLMMessages(normalizedContext, model),
          ...(isLastStep ? [Message.assistant(MAX_STEPS_PROMPT)] : []),
        ],
        tools: toolMaterialization?.definitions.filter((tool) => tool.name !== "image_generation") ?? [],
        toolChoice: isLastStep ? "none" : undefined,
      })
      if (yield* compaction.compactIfNeeded({ sessionID: session.id, entries, model, request }))
        return yield* Effect.die(continueAfterCompaction(currentStep))
      const startSnapshot = yield* snapshots.capture()
      const publisher = createLLMEventPublisher(events, { ...publication, snapshot: startSnapshot })
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths))
      let overflowFailure: ProviderErrorEvent | undefined
      const frame = routeImage || planning ? imageResponseFrame() : undefined
      const providerStream = llm.stream(request).pipe(
        Stream.flatMap((event) => Stream.fromIterable(frame ? frame.read(event) : [event])),
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (overflowFailure || publisher.hasProviderError()) return
            if (LLMEvent.is.providerError(event)) {
              if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
                overflowFailure = event
                return
              }
            }
            // A provider can return an unadvertised call. Never settle it with billing authority.
            // Only Core-issued text IDs may represent a pending image confirmation after replay.
            if (
              (event.type === "text-start" || event.type === "text-delta" || event.type === "text-end") &&
              (event.id.startsWith("image-intent-") || event.id.startsWith("provider:"))
            ) {
              const id = `provider:${event.id}`
              return yield* publish(
                event.type === "text-start"
                  ? LLMEvent.textStart({ ...event, id })
                  : event.type === "text-delta"
                    ? LLMEvent.textDelta({ ...event, id })
                    : LLMEvent.textEnd({ ...event, id }),
              )
            }
            if ("name" in event && event.name === "image_generation") {
              if (event.type === "tool-call")
                yield* publish(LLMEvent.providerError({ message: "Blocked an unrequested image call" }))
              return
            }
            yield* publish(event)
            if (event.type !== "tool-call") return
            toolCalls++
            if (event.providerExecuted) return
            if (["glob", "grep", "read", "list"].includes(event.name)) inspectedMaterials = true
            if (!toolMaterialization) {
              yield* withPublication(publisher.failUnsettledTools("Tools are disabled after the maximum agent steps"))
              return
            }
            needsContinuation = true
            const assistantMessageID = yield* publisher.assistantMessageID(event.id)
            yield* Effect.uninterruptibleMask((restore) =>
              restore(
                toolMaterialization.settle({
                  sessionID: session.id,
                  agent: agent.id,
                  assistantMessageID,
                  call: event,
                }),
              ).pipe(
                Effect.flatMap((settlement) => {
                  if (
                    event.name === "glob" &&
                    toolMaterialization.projectInventory &&
                    typeof event.input === "object" &&
                    event.input !== null &&
                    "pattern" in event.input &&
                    event.input.pattern === inventoryPattern &&
                    !("path" in event.input) &&
                    "limit" in event.input &&
                    event.input.limit === 1 &&
                    Array.isArray(settlement.output?.structured) &&
                    settlement.output.structured.length === 0
                  )
                    emptyInventory = true
                  return publish(
                    LLMEvent.toolResult({
                      id: event.id,
                      name: event.name,
                      result: settlement.result,
                      output: settlement.output,
                    }),
                    settlement.outputPaths ?? [],
                  )
                }),
              ),
            ).pipe(FiberSet.run(toolFibers))
          }),
        ),
        Effect.ensuring(withPublication(publisher.flush())),
      )

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const stream = yield* restore(providerStream).pipe(Effect.exit)
          const failure =
            stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
          if (
            recoverOverflow &&
            !publisher.hasAssistantStarted() &&
            isContextOverflowFailure(overflowFailure ?? failure) &&
            (yield* restore(recoverOverflow({ sessionID: session.id, entries, model, request })))
          )
            return yield* Effect.die(continueAfterOverflowCompaction(currentStep))
          if (overflowFailure) yield* publish(overflowFailure)
          const llmFailure = failure instanceof LLMError ? failure : undefined
          if (llmFailure && !publisher.hasProviderError()) {
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
            yield* withPublication(publisher.failAssistant(ToolErrorProjection.assistant(llmFailure)))
          }
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(toolFibers)
          const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
          if (settled._tag === "Failure" && isUserDeclined(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            return yield* Effect.interrupt
          }
          if (
            (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) ||
            (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
          ) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            if (publisher.hasActiveAssistant())
              yield* withPublication(publisher.failAssistant("Provider turn interrupted"))
          }
          if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
            yield* withPublication(publisher.failUnsettledTools(ToolErrorProjection.toolMessage))
          }
          const stepSettlement = publisher.stepSettlement()
          if (frame?.incomplete() && stream._tag === "Success" && !publisher.hasProviderError()) {
            yield* publisher.failAssistant("Incomplete response header. No image request was sent.")
            return { needsContinuation: false, step: currentStep }
          }
          const decision = frame?.decision()
          const slots = frame?.illustrations()
          if (slots && planning && stream._tag === "Success" && !publisher.hasProviderError()) {
            if (stepSettlement?.finish !== "stop") {
              yield* publisher.failAssistant("Incomplete illustration plan. No image request was sent.")
              return { needsContinuation: false, step: currentStep }
            }
            yield* restore(
              illustrate({
                plan: slots,
                emptyInventory: inventory?.user === planning.id && inventory.empty,
                user: planning,
                history: context,
                settings,
                questions,
                db,
                publication,
                publisher,
                tools: toolMaterialization,
              }),
            )
            needsContinuation = !isLastStep
          }
          if (decision && !routeImage) {
            yield* publisher.failAssistant("Standalone image authorization cannot be inferred from tool output.")
            return { needsContinuation: false, step: currentStep }
          }
          if (
            decision &&
            routeImage &&
            latest?.type === "user" &&
            stream._tag === "Success" &&
            !publisher.hasProviderError()
          ) {
            if (stepSettlement?.finish === "stop") {
              yield* restore(
                deliverImage(
                  routeImage.resolve(decision),
                  latest,
                  publication,
                  events,
                  publisher,
                  questions,
                  toolMaterialization,
                  (model) =>
                    reserveImage(
                      db,
                      { session: session.id, task: latest.id, slot: "standalone", call: `image-${latest.id}` },
                      model,
                      1,
                      false,
                    ).pipe(
                      Effect.flatMap((result) =>
                        result === "reserved"
                          ? Effect.void
                          : Effect.fail(new ToolFailure({ message: "This image request was already attempted." })),
                      ),
                    ),
                ),
              )
            } else yield* publisher.failAssistant("Incomplete image decision. No image request was sent.")
            return { needsContinuation: false, step: currentStep }
          }
          if (stepSettlement && !publisher.hasProviderError()) {
            const endSnapshot = yield* snapshots.capture()
            const files =
              startSnapshot && endSnapshot
                ? yield* snapshots
                    .files({ from: startSnapshot, to: endSnapshot })
                    .pipe(Effect.catch(() => Effect.succeed(undefined)))
                : undefined
            yield* withPublication(
              events.publish(SessionEvent.Step.Ended, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                finish: stepSettlement.finish,
                cost: 0,
                tokens: stepSettlement.tokens,
                snapshot: endSnapshot,
                files,
              }),
            )
          }
          if (publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
          if (stream._tag === "Success" && !publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
          if (stream._tag === "Failure") return yield* Effect.failCause(stream.cause)
          if (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
            return yield* Effect.failCause(settled.cause)
          return {
            needsContinuation: !publisher.hasProviderError() && needsContinuation,
            inventory:
              !slots && needsContinuation && inspectedMaterials && planning
                ? { user: planning.id, empty: emptyInventory && toolCalls === 1 }
                : undefined,
            step: currentStep,
          }
        }),
      )
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      inventory?: Inventory,
    ) => Effect.Effect<
      { readonly needsContinuation: boolean; readonly step: number; readonly inventory?: Inventory },
      RunError
    >

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step, inventory) {
      return yield* runTurnAttempt(sessionID, promotion, step, inventory).pipe(
        Effect.catchCause(
          Effect.fnUntraced(function* (cause) {
            const transition = turnTransition(cause)
            if (!transition) return yield* Effect.failCause(cause)
            if (transition._tag === "ContinueAfterOverflowCompaction")
              return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
            yield* Effect.yieldNow
            return yield* runAfterOverflowCompaction(sessionID, undefined, transition.step)
          }),
        ),
      )
    })

    const runTurn: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step, inventory) {
      return yield* runTurnAttempt(sessionID, promotion, step, inventory, compaction.compactAfterOverflow).pipe(
        Effect.catchCause(
          Effect.fnUntraced(function* (cause) {
            const transition = turnTransition(cause)
            if (!transition) return yield* Effect.failCause(cause)
            yield* Effect.yieldNow
            if (transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(sessionID, undefined, transition.step)
            return yield* runTurn(sessionID, undefined, transition.step)
          }),
        ),
      )
    })

    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
    }) {
      const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      if (!input.force && !hasSteer && !hasQueue) return
      yield* failInterruptedTools(input.sessionID)
      let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
      let shouldRun = input.force || hasSteer || hasQueue
      while (shouldRun) {
        let needsContinuation = true
        let step = 1
        let inventory: Inventory | undefined
        while (needsContinuation) {
          const result = yield* runTurn(input.sessionID, promotion, step, inventory)
          inventory = result.inventory
          needsContinuation = result.needsContinuation
          step = result.step + 1
          promotion = "steer"
          if (!needsContinuation) needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
        }
        shouldRun = yield* SessionInput.hasPending(db, input.sessionID, "queue")
        promotion = shouldRun ? "queue" : undefined
      }
    })

    return Service.of({
      run,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    llmClient,
    AgentV2.node,
    ToolRegistry.node,
    SessionRunnerModel.node,
    SessionStore.node,
    Location.node,
    SystemContextRegistry.node,
    SkillGuidance.node,
    ReferenceGuidance.node,
    Config.node,
    ImageGenerationSettings.node,
    QuestionV2.node,
    Snapshot.node,
    FSUtil.node,
    Database.node,
  ],
})
