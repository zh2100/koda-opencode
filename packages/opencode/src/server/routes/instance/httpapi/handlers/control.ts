import { Auth } from "@/auth"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { LogInput } from "../groups/control"
import { ProviderV2 } from "@opencode-ai/core/provider"

export const controlHandlers = HttpApiBuilder.group(RootHttpApi, "control", (handlers) =>
  Effect.gen(function* () {
    const authSet = Effect.fn("ControlHttpApi.authSet")(function* (_ctx: {
      params: { providerID: ProviderV2.ID }
      payload: Auth.Info
    }) {
      return yield* new HttpApiError.BadRequest()
    })

    const authRemove = Effect.fn("ControlHttpApi.authRemove")(function* (_ctx: {
      params: { providerID: ProviderV2.ID }
    }) {
      return yield* new HttpApiError.BadRequest()
    })

    const log = Effect.fn("ControlHttpApi.log")(function* (ctx: { payload: typeof LogInput.Type }) {
      const write =
        ctx.payload.level === "debug"
          ? Effect.logDebug
          : ctx.payload.level === "info"
            ? Effect.logInfo
            : ctx.payload.level === "warn"
              ? Effect.logWarning
              : Effect.logError
      yield* write(ctx.payload.message).pipe(Effect.annotateLogs(ctx.payload.extra ?? {}))
      return true
    })

    return handlers.handle("authSet", authSet).handle("authRemove", authRemove).handle("log", log)
  }),
)
