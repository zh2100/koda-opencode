import { For, Show, createMemo, type Component } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useSDK, SDKProvider } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useMcpToggle } from "@/context/mcp"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { DialogMcpV2 } from "./dialog-mcp-v2"
import "./settings-v2.css"

const statusLabels = {
  connected: "mcp.status.connected",
  failed: "mcp.status.failed",
  needs_auth: "mcp.status.needs_auth",
  needs_client_registration: "mcp.status.needs_client_registration",
  disabled: "mcp.status.disabled",
} as const

export const SettingsMcpV2: Component = () => {
  const language = useLanguage()
  const sdk = useSDK()
  const sync = useSync()
  const toggle = useMcpToggle()
  const dialog = useDialog()
  const items = createMemo(() =>
    Object.entries(sync().data.mcp ?? {})
      .map(([name, status]) => ({ name, status: status.status }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  const openAdd = () => {
    const directory = sdk().directory
    dialog.show(() => (
      <SDKProvider directory={directory}>
        <DialogMcpV2 mode="add" />
      </SDKProvider>
    ))
  }
  const openEdit = (name: string) => {
    const directory = sdk().directory
    dialog.show(() => (
      <SDKProvider directory={directory}>
        <DialogMcpV2 mode="edit" name={name} />
      </SDKProvider>
    ))
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-servers-header">
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("settings.mcp.title")}</h2>
          <ButtonV2 variant="ghost-muted" icon="plus" onClick={openAdd}>
            {language.t("settings.mcp.add")}
          </ButtonV2>
        </div>
      </div>
      <div class="settings-v2-tab-body">
        <p class="settings-v2-provider-description">{language.t("settings.mcp.description")}</p>
        <Show
          when={items().length > 0}
          fallback={<div class="settings-v2-provider-empty">{language.t("dialog.mcp.empty")}</div>}
        >
          <SettingsListV2>
            <For each={items()}>
              {(item) => {
                const mcpStatus = () => sync().data.mcp[item.name]
                const status = () => mcpStatus()?.status
                const label = () => {
                  const key = status() ? statusLabels[status() as keyof typeof statusLabels] : undefined
                  return key ? language.t(key) : ""
                }
                const error = () => {
                  const current = mcpStatus()
                  if (current?.status === "failed" || current?.status === "needs_client_registration") return current.error
                }
                const description = () => {
                  const detail = error()
                  if (status() === "needs_auth") return language.t("mcp.auth.clickToAuthenticate")
                  if (detail) return `${label()} · ${detail}`
                  return label()
                }
                return (
                  <SettingsRowV2 title={item.name} description={description()}>
                    <div class="flex items-center gap-2">
                      <ButtonV2 variant="ghost-muted" size="small" onClick={() => openEdit(item.name)}>
                        {language.t("settings.mcp.edit")}
                      </ButtonV2>
                      <Switch
                        checked={status() === "connected"}
                        disabled={status() === "pending" || toggle.isPending}
                        onChange={() => toggle.mutate(item.name)}
                        hideLabel
                      >
                        {item.name}
                      </Switch>
                    </div>
                  </SettingsRowV2>
                )
              }}
            </For>
          </SettingsListV2>
        </Show>
      </div>
    </>
  )
}
