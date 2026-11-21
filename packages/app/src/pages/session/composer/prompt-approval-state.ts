export type PromptApprovalID = "ask" | "auto" | "plan"

export function promptApprovalOptions(input: {
  ask: string
  auto: string
  plan: string
  hasPlan: boolean
}) {
  const items: Array<{ id: PromptApprovalID; label: string }> = [
    { id: "ask", label: input.ask },
    { id: "auto", label: input.auto },
  ]
  if (input.hasPlan) items.push({ id: "plan", label: input.plan })
  return items
}

export function promptApprovalCurrent(input: { auto: boolean; agent?: string }) {
  if (input.auto) return "auto" as const
  if (input.agent === "plan") return "plan" as const
  return "ask" as const
}

export function promptApprovalAgent(input: { id: PromptApprovalID; currentAgent?: string }) {
  if (input.id === "plan") return "plan"
  if (input.currentAgent === "plan") return "build"
  return undefined
}
