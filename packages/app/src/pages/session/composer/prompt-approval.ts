import { type Accessor } from "solid-js"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { usePermission } from "@/context/permission"

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
    if (auto()) return "auto"
    if (local.agent.current()?.name === "plan") return "plan"
    return "ask"
  }

  const options = () => {
    const items = [
      { id: "ask", label: language.t("prompt.approval.ask") },
      { id: "auto", label: language.t("prompt.approval.auto") },
    ]
    if (local.agent.list().some((item) => item.name === "plan")) {
      items.push({ id: "plan", label: language.t("prompt.approval.plan") })
    }
    return items
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
    if (id === "auto") {
      setAuto(true)
      if (local.agent.current()?.name === "plan") local.agent.set("build")
      return
    }
    setAuto(false)
    if (id === "plan") {
      local.agent.set("plan")
      return
    }
    if (local.agent.current()?.name === "plan") local.agent.set("build")
  }

  return { current, options, set }
}
