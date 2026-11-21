import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Option } from "effect"
import { LLM, LLMClient, Message, ToolCallPart, ToolResultPart, ToolErrorProjection } from "../src"
import { AnthropicMessages } from "../src/protocols/anthropic-messages"
import { OpenAIResponses } from "../src/protocols/openai-responses"

for (const provider of ["anthropic", "openai"] as const) {
  for (const malformed of ["missing", "wrong-type", "unknown-code", "wrong-ref"] as const) {
    test(`T20 historical ${provider} ${malformed} fails in prepare before transport`, async () => {
      const id = provider === "openai" ? "ws_safe" : "srvtoolu_safe"
      const model = (provider === "openai" ? OpenAIResponses.route : AnthropicMessages.route).model({ id: "safe" })
      const exit = await Effect.runPromiseExit(
        LLMClient.prepare(
          LLM.request({
            model,
            providerOptions: { openai: { store: true } },
            messages: [
              Message.assistant([
                ToolCallPart.make({ id, name: "web_search", input: {}, providerExecuted: true }),
                ToolResultPart.make({
                  id,
                  name: "web_search",
                  providerExecuted: true,
                  result: {
                    type: "error",
                    value:
                      malformed === "wrong-type"
                        ? { type: "web_fetch_tool_result_error", error_code: "unavailable" }
                        : malformed === "unknown-code"
                          ? { type: "web_search_tool_result_error", error_code: "not-known" }
                          : "historical diagnostic",
                  },
                  ...(provider === "openai" && malformed === "wrong-ref"
                    ? { providerMetadata: { openai: { itemId: "ws_other" } } }
                    : {}),
                }),
              ]),
            ],
          }),
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
        _tag: "LLM.Error",
        reason: { _tag: "InvalidRequest" },
      })
    })
  }
}
for (const name of ["__proto__", "constructor", "toString"]) {
  test(`T20 inherited property ${name} cannot become a hosted error rule`, () => {
    expect(
      ToolErrorProjection.blocked(
        ToolErrorProjection.project({
          id: "safe",
          name,
          executed: true,
          result: { type: "error", value: { type: "web_search_tool_result_error", error_code: "unavailable" } },
        }).result,
      ),
    ).toBe(true)
  })
}
