import { Relay } from "@opencode-ai/schema/relay"
import { RelayModel } from "@opencode-ai/schema/relay-model"
import { RelaySync } from "@opencode-ai/schema/relay-sync"
import { Model } from "@opencode-ai/schema/model"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError, ServiceUnavailableError, UnauthorizedError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

const RevisionPayload = Schema.Struct({
  revision: Schema.Number,
  operationId: Schema.optional(Schema.String),
  expectedEntityId: Schema.optional(Schema.String),
})

const ExpectedVendor = {
  expectedEntityId: Schema.optional(Schema.String),
  expectedVendorRevision: Schema.optional(Schema.Number),
}

const errors = [ConflictError, InvalidRequestError, ServiceUnavailableError, UnauthorizedError]

export const RelayGroup = HttpApiGroup.make("server.relay")
  .add(
    HttpApiEndpoint.get("relay.auth.get", "/api/relay/auth", {
      query: LocationQuery,
      success: Relay.AuthState,
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.relay.auth.get",
          summary: "Get relay auth",
          description: "Retrieve Relay independent vendor key status without secret values.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.put("relay.auth.vendor", "/api/relay/auth/vendors/:vendorId", {
      params: { vendorId: Relay.VendorID },
      query: LocationQuery,
      payload: Schema.Struct({
        createOnly: Schema.optional(Schema.Boolean),
        name: Schema.optional(Schema.String),
        baseURL: Schema.optional(Relay.VendorBaseURL),
        key: Schema.optional(Schema.String),
        ...RevisionPayload.fields,
      }),
      success: Relay.AuthState,
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.relay.auth.vendor",
          summary: "Create or update a relay vendor",
          description:
            "Create a custom vendor or update its name, key, and independent OpenAI-compatible baseURL. Omitted fields are preserved. An independent baseURL is required.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("relay.auth.vendor.key", "/api/relay/auth/vendors/:vendorId/key", {
      params: { vendorId: Relay.VendorID },
      query: LocationQuery,
      payload: RevisionPayload,
      success: Relay.AuthState,
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.relay.auth.vendor.key.clear",
          summary: "Clear a vendor key",
          description: "Remove one vendor API key without deleting the vendor.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("relay.auth.vendor.delete", "/api/relay/auth/vendors/:vendorId", {
      params: { vendorId: Relay.VendorID },
      query: LocationQuery,
      payload: RevisionPayload,
      success: Relay.AuthState,
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.relay.auth.vendor.delete",
          summary: "Delete a custom relay vendor",
          description: "Delete an independent vendor and retire its credential.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("relay.models.sync", "/api/relay/models/sync", {
      query: LocationQuery,
      payload: Schema.Struct({ retryNotice: Schema.optional(Schema.Boolean) }),
      success: RelaySync.Snapshot,
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.relay.models.sync",
          summary: "Synchronize relay catalog",
          description: "Adopt the shared catalog and return an atomic auth/catalog snapshot without upstream requests.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("relay.models.probe", "/api/relay/models/probe", {
      query: LocationQuery,
      payload: Schema.Struct({ vendorId: Relay.VendorID, ...ExpectedVendor }),
      success: Schema.Struct({ count: Schema.Number }),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.relay.models.probe",
          summary: "Probe relay connectivity",
          description: "Fetch /v1/models for a vendor key without writing the candidate cache.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("relay.models.refresh", "/api/relay/models/refresh", {
      query: LocationQuery,
      payload: Schema.Struct({ vendorId: Relay.VendorID, ...ExpectedVendor }),
      success: Schema.Array(RelayModel.Candidate),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.relay.models.refresh",
          summary: "Refresh relay model candidates",
          description: "Fetch /v1/models for a vendor key and update the candidate cache.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("relay.models.managed", "/api/relay/models", {
      query: LocationQuery,
      success: Schema.Array(RelayModel.Managed),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.relay.models.managed",
          summary: "List managed relay models",
          description: "List models that have been added to the managed registry.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("relay.models.candidates", "/api/relay/models/candidates", {
      query: Schema.Struct({
        ...LocationQuery.fields,
        vendorId: Schema.optional(Relay.VendorID),
      }),
      success: Schema.Array(RelayModel.Candidate),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.relay.models.candidates",
          summary: "List relay model candidates",
          description: "List cached upstream models. This is not the session selector.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.put("relay.models.visibility", "/api/relay/models/visibility", {
      query: LocationQuery,
      payload: Schema.Struct({
        vendorId: Relay.VendorID,
        modelId: Model.ID,
        visible: Schema.Boolean,
        expectedEntityId: Schema.optional(Schema.String),
      }),
      success: Schema.Array(RelayModel.Managed),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.relay.models.visibility",
          summary: "Set relay model visibility",
          description: "Show or hide a candidate in the managed model registry.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "relay",
      description: "Relay vendor authentication and catalog routes.",
    }),
  )
