import { For, Show, createResource, type Component } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { SDKProvider, useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { DialogScheduledV2 } from "./dialog-scheduled-v2"
import { showToast } from "@/utils/toast"
import "./settings-v2.css"

export const SettingsScheduledV2: Component = () => {
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const dialog = useDialog()
  const [tasks, { refetch }] = createResource(() => serverSDK().generatedApi["server.scheduledTask"].list())

  const run = async (taskID: string) => {
    try {
      await serverSDK().generatedApi["server.scheduledTask"].run({ taskID })
      void refetch()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      showToast({ title: language.t("common.requestFailed"), description: message })
    }
  }

  const resume = async (taskID: string) => {
    try {
      await serverSDK().generatedApi["server.scheduledTask"].enable({ taskID, enabled: true })
      void refetch()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      showToast({ title: language.t("common.requestFailed"), description: message })
    }
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-servers-header">
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("settings.scheduled.title")}</h2>
          <ButtonV2
            variant="ghost-muted"
            icon="plus"
            onClick={() => {
              const directory = sdk().directory
              dialog.show(() => (
                <SDKProvider directory={directory}>
                  <DialogScheduledV2 onCreated={() => void refetch()} />
                </SDKProvider>
              ))
            }}
          >
            {language.t("settings.scheduled.add")}
          </ButtonV2>
        </div>
      </div>
      <div class="settings-v2-tab-body">
        <p class="settings-v2-provider-description">{language.t("settings.scheduled.description")}</p>
        <Show
          when={(tasks() ?? []).length > 0}
          fallback={<div class="settings-v2-provider-empty">{language.t("settings.scheduled.empty")}</div>}
        >
          <SettingsListV2>
            <For each={tasks() ?? []}>
              {(task) => (
                <SettingsRowV2
                  title={task.name}
                  description={
                    task.schedule === "daily"
                      ? language.t("settings.scheduled.daily")
                      : language.t("settings.scheduled.once")
                  }
                >
                  <Show
                    when={task.enabled}
                    fallback={
                      <ButtonV2 variant="ghost-muted" size="small" onClick={() => void resume(task.id)}>
                        {language.t("common.continue")}
                      </ButtonV2>
                    }
                  >
                    <ButtonV2 variant="ghost-muted" size="small" onClick={() => void run(task.id)}>
                      {language.t("common.submit")}
                    </ButtonV2>
                  </Show>
                </SettingsRowV2>
              )}
            </For>
          </SettingsListV2>
        </Show>
      </div>
    </>
  )
}
