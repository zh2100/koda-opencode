import { McpEditError } from "@/config/mcp-edit"
import { Context, Effect } from "effect"

export interface Interface {
  readonly run: Effect.Effect<void, McpEditError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceBootstrap") {}

export * as InstanceBootstrap from "./bootstrap-service"
