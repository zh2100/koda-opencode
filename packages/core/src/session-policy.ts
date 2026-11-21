import { Wildcard } from "./util/wildcard"
import { Permission } from "@opencode-ai/schema/permission"
import type { Session } from "@opencode-ai/schema/session"

// Unclassified capabilities stay unavailable in plan, including third-party tools.
const readActions = ["read", "glob", "grep", "list", "webfetch", "websearch", "question", "todoread"]
export function sessionPermissions(mode: Session.Info["approvalMode"], rules: Permission.Ruleset): Permission.Ruleset {
  if (mode !== "plan") return rules
  return [
    ...rules,
    { action: "*", resource: "*", effect: "deny" },
    ...readActions.flatMap((action) => {
      const matching = rules.filter((rule) => Wildcard.match(action, rule.action))
      return matching.length
        ? matching.map((rule) => ({ ...rule, action }))
        : [{ action, resource: "*", effect: "ask" as const }]
    }),
  ]
}
