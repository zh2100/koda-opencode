import type { createLLMEventPublisher } from "./publish-llm-event"
import type { ToolRegistry } from "../../tool/registry"
import type { AgentV2 } from "../../agent"
import { LLMEvent } from "@opencode-ai/llm"
import type { Tool } from "../../tool/tool"
import { createHash } from "node:crypto"
import { Effect } from "effect"

export const settleImage = Effect.fn("SessionRunner.settleImage")(function* (
  id: string,
  prompt: string,
  publication: Parameters<typeof createLLMEventPublisher>[1] & { readonly agent: AgentV2.ID },
  publisher: ReturnType<typeof createLLMEventPublisher>,
  toolMaterialization: ToolRegistry.Materialization,
  beforeImagePost?: Tool.Context["beforeImagePost"],
) {
  const call = LLMEvent.toolCall({ id, name: "image_generation", input: { prompt } })
  yield* publisher.publish(call)
  return yield* toolMaterialization
    .settle({
      sessionID: publication.sessionID,
      agent: publication.agent,
      assistantMessageID: yield* publisher.assistantMessageID(call.id),
      call,
      beforeImagePost,
    })
    .pipe(
      Effect.flatMap((settlement) =>
        publisher
          .publish(
            LLMEvent.toolResult({ id: call.id, name: call.name, result: settlement.result, output: settlement.output }),
            settlement.outputPaths,
          )
          .pipe(
            Effect.map(() => {
              if (!publisher.hasImageReceipt(id)) return
              const file = settlement.output?.content.find((part) => part.type === "file")
              if (file?.type === "file")
                return createHash("sha256")
                  .update(Buffer.from(file.uri.slice(file.uri.indexOf(",") + 1), "base64"))
                  .digest("hex")
            }),
          ),
      ),
      Effect.onExit((exit) =>
        exit._tag === "Failure"
          ? publisher
              .failUnsettledTools("No verified image result. No retry was attempted.")
              .pipe(
                Effect.andThen(
                  publisher.failAssistant("Image generation did not finish. Check the provider before retrying."),
                ),
              )
          : Effect.void,
      ),
    )
})
