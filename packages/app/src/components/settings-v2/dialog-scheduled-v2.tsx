import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import "./settings-v2.css"

type Kind = "once" | "daily"

export const DialogScheduledV2: Component<{ onCreated: () => void }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const models = useModels()
  const sdk = useSDK()
  const sync = useSync()
  const serverSDK = useServerSDK()
  const [store, setStore] = createStore({
    name: "",
    prompt: "",
    schedule: "once" as Kind,
    runAt: "",
    error: "",
    busy: false,
  })
  const kinds = ["once", "daily"] as const

  const save = async () => {
    const name = store.name.trim()
    const prompt = store.prompt.trim()
    const runAt = Date.parse(store.runAt)
    const recent = models.recent.list()[0]
    const model = (recent ? models.find(recent) : undefined) ?? models.list()[0]
    if (!name) {
      setStore("error", language.t("settings.scheduled.error.name"))
      return
    }
    if (!prompt) {
      setStore("error", language.t("settings.scheduled.error.prompt"))
      return
    }
    if (!Number.isFinite(runAt)) {
      setStore("error", language.t("settings.scheduled.error.time"))
      return
    }
    if (!model) {
      setStore("error", language.t("settings.scheduled.error.model"))
      return
    }
    setStore("busy", true)
    setStore("error", "")
    try {
      await serverSDK().generatedApi["server.scheduledTask"].create({
        name,
        projectID: sync().project?.id ?? sync().data.project,
        location: { directory: sdk().directory },
        prompt: { text: prompt },
        schedule: store.schedule,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        runAt,
        model: { id: model.id, providerID: model.provider.id },
        approvalMode: "auto",
        enabled: true,
      })
      props.onCreated()
      dialog.close()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStore("error", message)
      showToast({ title: language.t("common.requestFailed"), description: message })
    } finally {
      setStore("busy", false)
    }
  }

  return (
    <Dialog fit class="settings-v2-server-dialog">
      <DialogHeader hideClose={true}>
        <DialogTitle>{language.t("settings.scheduled.add")}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
        <div class="flex w-full min-w-0 flex-col gap-6">
          <div class="flex w-full min-w-0 flex-col gap-2">
            <label class="settings-v2-server-dialog-label">{language.t("settings.scheduled.field.name")}</label>
            <TextInputV2
              type="text"
              appearance="large"
              class="!w-full self-stretch"
              value={store.name}
              autofocus
              disabled={store.busy}
              onInput={(event) => setStore("name", event.currentTarget.value)}
            />
          </div>
          <div class="flex w-full min-w-0 flex-col gap-2">
            <label class="settings-v2-server-dialog-label">{language.t("settings.scheduled.field.prompt")}</label>
            <TextInputV2
              type="text"
              appearance="large"
              class="!w-full self-stretch"
              value={store.prompt}
              disabled={store.busy}
              onInput={(event) => setStore("prompt", event.currentTarget.value)}
            />
          </div>
          <div class="flex w-full min-w-0 flex-col gap-2">
            <label class="settings-v2-server-dialog-label">{language.t("settings.scheduled.field.schedule")}</label>
            <SelectV2
              appearance="inline"
              options={[...kinds]}
              current={store.schedule}
              placement="bottom-start"
              gutter={6}
              label={(option) =>
                option === "daily" ? language.t("settings.scheduled.daily") : language.t("settings.scheduled.once")
              }
              onSelect={(option) => option && setStore("schedule", option)}
            />
          </div>
          <div class="flex w-full min-w-0 flex-col gap-2">
            <label class="settings-v2-server-dialog-label">{language.t("settings.scheduled.field.time")}</label>
            <TextInputV2
              type="datetime-local"
              appearance="large"
              class="!w-full self-stretch"
              value={store.runAt}
              disabled={store.busy}
              onInput={(event) => setStore("runAt", event.currentTarget.value)}
            />
          </div>
          <Show when={store.error}>
            <span class="settings-v2-server-dialog-error">{store.error}</span>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" disabled={store.busy} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={store.busy} onClick={() => void save()}>
          {store.busy ? language.t("common.saving") : language.t("common.save")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
