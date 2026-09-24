import { Component, Show, createMemo, createSignal, startTransition } from "solid-js"
import { Dialog } from "@opencode-ai/ui/v2/dialog-v2"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsGeneralV2 } from "./general"
import { SettingsKeybinds } from "../settings-keybinds"
import { SettingsProvidersV2 } from "./providers"
import { SettingsModelsV2 } from "./models"
import "./settings-v2.css"
import { SettingsServersV2 } from "./servers"
import { SettingsSkillsV2 } from "./skills"
import { SettingsMcpV2 } from "./mcp"
import { SettingsScheduledV2 } from "./scheduled"
import { useRelayGates } from "@/hooks/use-relay-gates"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLayout } from "@/context/layout"
import { useTabs } from "@/context/tabs"
import { useServerSync } from "@/context/server-sync"
import { SDKProvider } from "@/context/sdk"

export const DialogSettings: Component<{
  sessionID?: string
  defaultValue?: string
}> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const layout = useLayout()
  const tabs = useTabs()
  const serverSync = useServerSync()
  const gates = useRelayGates()
  const [tab, setTab] = createSignal(props.defaultValue ?? "general")
  const directory = createMemo(() => {
    const route = layout.route()
    if (route.type === "dir-new-sesssion") return route.dir
    if (route.type === "draft") {
      const draft = tabs.store.find((item) => item.type === "draft" && item.draftID === route.draftID)
      return draft?.type === "draft" ? draft.directory : undefined
    }
    if (route.type === "session") return serverSync().session.get(route.sessionId)?.directory
    return layout.home.selection().directory ?? layout.projects.list()[0]?.worktree
  })

  const showProviders = () => {
    void dialog.show(() => <DialogSettings sessionID={props.sessionID} defaultValue="providers" />)
  }

  return (
    <Dialog size="x-large" variant="settings" class="settings-v2-dialog">
      <TabsV2
        orientation="vertical"
        variant="settings"
        value={tab()}
        onChange={(value) => void startTransition(() => setTab(value))}
        class="settings-v2"
      >
        <TabsV2.List>
          <div class="flex flex-col justify-between h-full w-full">
            <div class="flex flex-col gap-3 w-full">
              <div class="flex flex-col gap-3">
                <div class="flex flex-col gap-1.5">
                  <TabsV2.SectionTitle>{language.t("settings.section.desktop")}</TabsV2.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <TabsV2.Trigger value="general">
                      <Icon name="sliders" />
                      {language.t("settings.tab.general")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="shortcuts">
                      <Icon name="keyboard" />
                      {language.t("settings.tab.shortcuts")}
                    </TabsV2.Trigger>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <TabsV2.SectionTitle>{language.t("settings.section.server")}</TabsV2.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <TabsV2.Trigger value="servers">
                      <Icon name="server" />
                      {language.t("status.popover.tab.servers")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="providers">
                      <Icon name="providers" />
                      {language.t("settings.providers.title")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="models">
                      <Icon name="models" />
                      {language.t("settings.models.title")}
                    </TabsV2.Trigger>
                    <Show when={gates().relaySkills}>
                      <TabsV2.Trigger value="skills">
                        <Icon name="checklist" />
                        {language.t("settings.skills.title")}
                      </TabsV2.Trigger>
                    </Show>
                    <Show when={gates().relayMcp}>
                      <TabsV2.Trigger value="mcp">
                        <Icon name="mcp" />
                        {language.t("settings.mcp.title")}
                      </TabsV2.Trigger>
                    </Show>
                    <Show when={gates().scheduledTasks}>
                      <TabsV2.Trigger value="scheduled">
                        <Icon name="status" />
                        {language.t("settings.scheduled.title")}
                      </TabsV2.Trigger>
                    </Show>
                  </div>
                </div>
              </div>
            </div>
            <div class="settings-v2-nav-footer">
              <span>{language.t("app.name.desktop")}</span>
              <span>数元AI</span>
            </div>
          </div>
        </TabsV2.List>
        <TabsV2.Content value="general" class="settings-v2-panel">
          <SettingsGeneralV2 sessionID={props.sessionID} />
        </TabsV2.Content>
        <TabsV2.Content value="shortcuts" class="settings-v2-panel">
          <SettingsKeybinds v2 />
        </TabsV2.Content>
        <TabsV2.Content value="servers" class="settings-v2-panel">
          <SettingsServersV2 />
        </TabsV2.Content>
        <TabsV2.Content value="providers" class="settings-v2-panel">
          <SettingsProvidersV2 directory={directory} onBack={showProviders} />
        </TabsV2.Content>
        <TabsV2.Content value="models" class="settings-v2-panel">
          <SettingsModelsV2 />
        </TabsV2.Content>
        <Show when={gates().relaySkills}>
          <TabsV2.Content value="skills" class="settings-v2-panel">
            <Show
              when={directory()}
              keyed
              fallback={<div class="settings-v2-provider-empty">{language.t("sidebar.empty.description")}</div>}
            >
              {(dir) => (
                <SDKProvider directory={dir}>
                  <SettingsSkillsV2 />
                </SDKProvider>
              )}
            </Show>
          </TabsV2.Content>
        </Show>
        <Show when={gates().relayMcp}>
          <TabsV2.Content value="mcp" class="settings-v2-panel">
            <Show
              when={directory()}
              keyed
              fallback={<div class="settings-v2-provider-empty">{language.t("sidebar.empty.description")}</div>}
            >
              {(dir) => (
                <SDKProvider directory={dir}>
                  <SettingsMcpV2 />
                </SDKProvider>
              )}
            </Show>
          </TabsV2.Content>
        </Show>
        <Show when={gates().scheduledTasks}>
          <TabsV2.Content value="scheduled" class="settings-v2-panel">
            <Show
              when={directory()}
              keyed
              fallback={<div class="settings-v2-provider-empty">{language.t("sidebar.empty.description")}</div>}
            >
              {(dir) => (
                <SDKProvider directory={dir}>
                  <SettingsScheduledV2 />
                </SDKProvider>
              )}
            </Show>
          </TabsV2.Content>
        </Show>
      </TabsV2>
    </Dialog>
  )
}
