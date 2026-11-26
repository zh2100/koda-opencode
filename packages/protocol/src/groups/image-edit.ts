import { ImageEdit } from "@opencode-ai/schema/image-edit"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError, ServiceUnavailableError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export { ImageEdit }

export const ImageEditGroup = HttpApiGroup.make("server.imageEdit")
  .add(HttpApiEndpoint.get("imageEdit.target", "/api/image-edit/target", {
    query: LocationQuery,
    success: Schema.NullOr(ImageEdit.Target),
  }).annotateMerge(locationQueryOpenApi).annotateMerge(OpenApi.annotations({ identifier: "v2.imageEdit.target" })))
  .add(HttpApiEndpoint.get("imageEdit.status", "/api/image-edit/status", {
    query: LocationQuery,
    success: ImageEdit.Status,
  }).annotateMerge(locationQueryOpenApi).annotateMerge(OpenApi.annotations({ identifier: "v2.imageEdit.status" })))
  .add(HttpApiEndpoint.post("imageEdit.submit", "/api/image-edit", {
    query: LocationQuery,
    payload: ImageEdit.Request,
    success: ImageEdit.Result,
    error: [InvalidRequestError, ConflictError, ServiceUnavailableError],
  }).annotateMerge(locationQueryOpenApi).annotateMerge(OpenApi.annotations({ identifier: "v2.imageEdit.submit" })))
