import { RelayAuth } from "@opencode-ai/core/relay-auth"
import { RelayCatalog } from "@opencode-ai/core/relay-catalog"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError, ServiceUnavailableError, UnauthorizedError } from "@opencode-ai/protocol/errors"
import { Api } from "../api"

const mapError = (error: RelayAuth.AuthError | RelayCatalog.CatalogError) => {
  if (error.info.code === "REVISION_CONFLICT" || error.info.code === "REQUEST_CONFLICT") {
    return new ConflictError({ message: error.info.code, resource: "relay.auth" })
  }
  if (error.info.code === "SECRET_STORE_UNAVAILABLE") {
    return new ServiceUnavailableError({ message: error.info.code, service: "secret-store" })
  }
  if (error.info.code === "KEY_MISSING" || error.info.code === "KEY_REJECTED") {
    return new UnauthorizedError({ message: error.info.code })
  }
  return new InvalidRequestError({ message: error.info.code })
}

export const RelayHandler = HttpApiBuilder.group(Api, "server.relay", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* RelayAuth.Service
    const catalog = yield* RelayCatalog.Service
    return handlers
      .handle("relay.auth.get", () => auth.get().pipe(Effect.mapError(mapError)))
      .handle("relay.auth.mode", (ctx) =>
        auth.setMode(ctx.payload).pipe(Effect.mapError(mapError)),
      )
      .handle("relay.auth.unified", (ctx) =>
        auth.setUnifiedKey(ctx.payload).pipe(Effect.mapError(mapError)),
      )
      .handle("relay.auth.unified.clear", (ctx) =>
        auth.clearUnifiedKey(ctx.payload).pipe(Effect.mapError(mapError)),
      )
      .handle("relay.auth.vendor", (ctx) =>
        auth
          .setVendor({
            id: ctx.params.vendorId,
            name: ctx.payload.name,
            key: ctx.payload.key,
            revision: ctx.payload.revision,
            operationId: ctx.payload.operationId,
          })
          .pipe(Effect.mapError(mapError)),
      )
      .handle("relay.auth.vendor.key", (ctx) =>
        auth
          .clearVendorKey({
            id: ctx.params.vendorId,
            revision: ctx.payload.revision,
            operationId: ctx.payload.operationId,
          })
          .pipe(Effect.mapError(mapError)),
      )
      .handle("relay.auth.rollback", (ctx) =>
        auth.rollback(ctx.payload).pipe(Effect.mapError(mapError)),
      )
      .handle("relay.auth.vendor.delete", (ctx) =>
        auth
          .deleteVendor({
            id: ctx.params.vendorId,
            revision: ctx.payload.revision,
            operationId: ctx.payload.operationId,
          })
          .pipe(Effect.mapError(mapError)),
      )
      .handle("relay.models.probe", (ctx) => catalog.probe(ctx.payload.vendorId).pipe(Effect.mapError(mapError)))
      .handle("relay.models.refresh", (ctx) => catalog.refresh(ctx.payload.vendorId).pipe(Effect.mapError(mapError)))
      .handle("relay.models.managed", () => catalog.managed().pipe(Effect.mapError(mapError)))
      .handle("relay.models.candidates", (ctx) => catalog.candidates(ctx.query.vendorId).pipe(Effect.mapError(mapError)))
      .handle("relay.models.visibility", (ctx) => catalog.setVisibility(ctx.payload).pipe(Effect.mapError(mapError)))
  }),
)
