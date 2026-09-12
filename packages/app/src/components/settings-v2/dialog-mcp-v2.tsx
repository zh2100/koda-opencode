import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useQueryClient } from "@tanstack/solid-query"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import "./settings-v2.css"

type Kind = "local" | "remote"

export const DialogMcpV2: Component<{
  mode: "add" | "edit"
  name?: string
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const queryClient = useQueryClient()
  const existing = () => (props.name ? serverSync().data.config.mcp?.[props.name] : undefined)
  const initial = existing()
  const [store, setStore] = createStore({
    name: props.name ?? "",
    kind: (initial && "type" in initial && initial.type === "remote" ? "remote" : "local") as Kind,
    command: initial && "command" in initial ? initial.command.join(" ") : "",
    url: initial && "url" in initial ? initial.url : "",
    error: "",
    busy: false,
  })

  const kinds = ["local", "remote"] as const
  const title = () => (props.mode === "add" ? language.t("settings.mcp.add") : language.t("settings.mcp.edit"))

  const save = async () => {
    const name = store.name.trim()
    if (!name) {
      setStore("error", language.t("settings.mcp.error.name"))
      return
    }
    if (store.kind === "local" && !store.command.trim()) {
      setStore("error", language.t("settings.mcp.error.command"))
      return
    }
    if (store.kind === "remote" && !store.url.trim()) {
      setStore("error", language.t("settings.mcp.error.url"))
      return
    }
    setStore("busy", true)
    setStore("error", "")
    const config =
      store.kind === "local"
        ? { type: "local" as const, command: store.command.trim().split(/\s+/).filter(Boolean) }
        : { type: "remote" as const, url: store.url.trim() }
    try {
      await serverSync().updateConfig({ mcp: { [name]: config } })
      await sdk().client.mcp.add({ name, config, directory: sdk().directory }).catch(() => undefined)
      await queryClient.invalidateQueries({ queryKey: [serverSDK().scope, sdk().directory, "mcp"] })
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
        <DialogTitle>{title()}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
        <div class="flex w-full min-w-0 flex-col gap-6">
          <div class="flex w-full min-w-0 flex-col gap-2">
            <label class="settings-v2-server-dialog-label">{language.t("settings.mcp.field.name")}</label>
            <TextInputV2
              type="text"
              appearance="large"
              class="!w-full self-stretch"
              value={store.name}
              disabled={props.mode === "edit" || store.busy}
              autofocus={props.mode === "add"}
              onInput={(event) => setStore("name", event.currentTarget.value)}
            />
          </div>
          <div class="flex w-full min-w-0 flex-col gap-2">
            <label class="settings-v2-server-dialog-label">{language.t("settings.mcp.field.type")}</label>
            <SelectV2
              appearance="inline"
              options={[...kinds]}
              current={store.kind}
              placement="bottom-start"
              gutter={6}
              label={(option) =>
                option === "local" ? language.t("settings.mcp.type.local") : language.t("settings.mcp.type.remote")
              }
              onSelect={(option) => option && setStore("kind", option)}
            />
          </div>
          <Show when={store.kind === "local"}>
            <div class="flex w-full min-w-0 flex-col gap-2">
              <label class="settings-v2-server-dialog-label">{language.t("settings.mcp.field.command")}</label>
              <TextInputV2
                type="text"
                appearance="large"
                class="!w-full self-stretch"
                value={store.command}
                placeholder={language.t("settings.mcp.field.command.placeholder")}
                disabled={store.busy}
                onInput={(event) => setStore("command", event.currentTarget.value)}
              />
            </div>
          </Show>
          <Show when={store.kind === "remote"}>
            <div class="flex w-full min-w-0 flex-col gap-2">
              <label class="settings-v2-server-dialog-label">{language.t("settings.mcp.field.url")}</label>
              <TextInputV2
                type="text"
                appearance="large"
                class="!w-full self-stretch"
                value={store.url}
                placeholder={language.t("settings.mcp.field.url.placeholder")}
                disabled={store.busy}
                onInput={(event) => setStore("url", event.currentTarget.value)}
              />
            </div>
          </Show>
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
