import { type Accessor } from "solid-js"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { usePermission } from "@/context/permission"
import {
  promptApprovalAgent,
  promptApprovalCurrent,
  promptApprovalOptions,
  type PromptApprovalID,
} from "./prompt-approval-state"

export function createPromptApproval(input: {
  sessionID: Accessor<string | undefined>
  directory: Accessor<string>
}) {
  const language = useLanguage()
  const local = useLocal()
  const permission = usePermission()

  const auto = () => {
    const id = input.sessionID()
    if (id) return permission.isAutoAccepting(id, input.directory())
    return permission.isAutoAcceptingDirectory(input.directory())
  }

  const current = () => {
    return promptApprovalCurrent({ auto: auto(), agent: local.agent.current()?.name })
  }

  const options = () => {
    return promptApprovalOptions({
      ask: language.t("prompt.approval.ask"),
      auto: language.t("prompt.approval.auto"),
      plan: language.t("prompt.approval.plan"),
      hasPlan: local.agent.list().some((item) => item.name === "plan"),
    })
  }

  const setAuto = (on: boolean) => {
    const id = input.sessionID()
    const directory = input.directory()
    if (id) {
      if (on) permission.enableAutoAccept(id, directory)
      else permission.disableAutoAccept(id, directory)
      return
    }
    if (on !== permission.isAutoAcceptingDirectory(directory)) permission.toggleAutoAcceptDirectory(directory)
  }

  const set = (id: string) => {
    if (id !== "ask" && id !== "auto" && id !== "plan") return
    const value = id as PromptApprovalID
    if (id === "auto") {
      setAuto(true)
      const agent = promptApprovalAgent({ id: value, currentAgent: local.agent.current()?.name })
      if (agent) local.agent.set(agent)
      return
    }
    setAuto(false)
    const agent = promptApprovalAgent({ id: value, currentAgent: local.agent.current()?.name })
    if (agent) local.agent.set(agent)
  }

  return { current, options, set }
}
