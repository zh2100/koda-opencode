import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { bindDialog, useDialog } from "@opencode-ai/ui/context/dialog"
import { createEffect, createMemo, createSignal, onCleanup, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import {
  applyLoadedConfig,
  canSaveMcp,
  emptyMcpDraft,
  mcpErrorCode,
  mcpErrorRef,
  mcpLoadState,
  mcpReloadSucceeded,
  mergeMcpConfig,
  reconcileMcpReload,
  type McpConfigRecord,
  type McpConflict,
  type McpField,
} from "./mcp-form"
import "./settings-v2.css"

function mcpFailureMessage(
  code: string | undefined,
  translate: (key: string) => string,
  error: unknown,
) {
  if (code === "MCP_VERSION_CONFLICT") return translate("settings.mcp.error.conflict")
  if (code === "MCP_SOURCE_CHANGED") return translate("settings.mcp.error.sourceChanged")
  if (code === "MCP_SOURCE_READ_ONLY") return translate("settings.mcp.error.readOnly")
  if (code === "MCP_SOURCE_MISSING" || code === "MCP_ENTRY_MISSING") return translate("settings.mcp.error.missing")
  if (code === "MCP_DOCUMENT_INVALID") return translate("settings.mcp.error.invalid")
  if (code === "MCP_LOCK_TIMEOUT" || code === "MCP_WRITE_FAILED") return translate("settings.mcp.error.unavailable")
  return error instanceof Error ? error.message : String(error)
}

export const DialogMcpV2: Component<{
  mode: "add" | "edit"
  name?: string
  dialogID?: string
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const queryClient = useQueryClient()
  const [request, setRequest] = createSignal(0)
  const [operation, setOperation] = createSignal(0)
  const [generation, setGeneration] = createSignal(0)
  const mounted = { current: true }
  const dialogID = props.dialogID ?? Math.random().toString(36).slice(2)
  const identity = createMemo(() => JSON.stringify([serverSDK().scope, sdk().directory, props.mode, props.name]))
  onCleanup(() => {
    mounted.current = false
    setOperation((current) => current + 1)
  })
  createEffect(() => {
    identity()
    setGeneration((current) => current + 1)
  })
  const configQuery = useQuery(() => {
    const context = sdk()
    const name = props.name ?? ""
    return {
      queryKey: [serverSDK().scope, context.directory, "mcp-config", name, request()],
      enabled: props.mode === "edit",
      queryFn: async () => {
        const result = await context.client.config.mcpSource(
          { name, directory: context.directory },
          { throwOnError: true },
        )
        return result.data
      },
    }
  })
  const existing = () => (props.name ? (configQuery.data?.config as McpConfigRecord | undefined) : undefined)
  const state = () =>
    mcpLoadState({
      mode: props.mode,
      pending: configQuery.isPending,
      error: configQuery.isError,
      config: existing(),
    })
  const [store, setStore] = createStore({
    ...emptyMcpDraft(props.name ?? ""),
    error: "",
    busy: false,
    conflict: undefined as McpConflict | undefined,
    original: undefined as McpConfigRecord | undefined,
    saved: false,
    refreshError: "",
  })

  createEffect(() => {
    identity()
    setStore({
      ...emptyMcpDraft(props.name ?? ""),
      error: "",
      busy: false,
      conflict: undefined,
      original: undefined,
      saved: false,
      refreshError: "",
    })
  })

  createEffect(() => {
    if (state() !== "success" || props.mode !== "edit" || store.conflict) return
    const loaded = existing()
    if (!store.original) setStore("original", loaded)
    const next = applyLoadedConfig(store, props.name ?? "", loaded)
    setStore({
      name: next.name,
      kind: next.kind,
      command: next.command,
      commandArgs: next.commandArgs,
      url: next.url,
    })
  })

  const currentIdentity = () => JSON.stringify([serverSDK().scope, sdk().directory, props.mode, props.name])
  const owns = (ticket: { generation: number; operation: number; identity?: string }) =>
    mounted.current &&
    generation() === ticket.generation &&
    operation() === ticket.operation &&
    (ticket.identity === undefined || currentIdentity() === ticket.identity)

  const reloadLatest = async () => {
    const ticket = { generation: generation(), operation: operation() + 1 }
    setOperation(ticket.operation)
    const result = await configQuery.refetch()
    if (!owns(ticket)) return
    // A failed refetch still exposes the previous cached value. Compare only a successful read.
    if (!mcpReloadSucceeded(result)) {
      setStore("error", language.t("settings.mcp.error.load"))
      return
    }
    const latest = result.data?.config as McpConfigRecord | undefined
    const reconciled = reconcileMcpReload({
      original: store.original,
      latest,
      draft: store,
      pending: store.conflict?.fields,
    })
    if (!owns(ticket)) return
    setStore({
      ...reconciled.draft,
      original: reconciled.original,
      conflict: reconciled.fields.length
        ? { code: "MCP_FIELD_CONFLICT", fields: reconciled.fields }
        : undefined,
      error: reconciled.fields.length ? language.t("settings.mcp.error.fieldConflict") : "",
    })
  }

  const refreshSavedConfig = async (scope: string, directory: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [scope, directory, "mcp"] }, { throwOnError: true }),
      queryClient.invalidateQueries({ queryKey: [scope, directory, "mcp-config"] }, { throwOnError: true }),
    ])
  }

  const finishOwnedSave = (ticket: { generation: number; operation: number; identity?: string }) => {
    if (!owns(ticket)) return
    dialog.close(dialogID)
  }

  const retryRefresh = async () => {
    if (!store.saved || store.busy) return
    const ticket = { generation: generation(), operation: operation() }
    const context = sdk()
    const scope = serverSDK().scope
    setStore("busy", true)
    setStore("refreshError", "")
    try {
      await refreshSavedConfig(scope, context.directory)
      finishOwnedSave(ticket)
    } catch (refresh) {
      if (!owns(ticket)) return
      const message = refresh instanceof Error ? refresh.message : String(refresh)
      setStore("refreshError", message || language.t("settings.mcp.error.refresh"))
    } finally {
      if (owns(ticket)) setStore("busy", false)
    }
  }

  const chooseField = (field: McpField, value: "draft" | "latest") => {
    const latest = existing()
    const loaded = applyLoadedConfig(emptyMcpDraft(props.name ?? ""), props.name ?? "", latest)
    if (value === "latest") {
      if (field === "kind") setStore("kind", loaded.kind)
      if (field === "command") setStore("command", loaded.command)
      if (field === "url") setStore("url", loaded.url)
    }
    setStore("touched", field, value === "draft")
    const fields = (store.conflict?.fields ?? []).filter((item) => item !== field)
    setStore("conflict", fields.length ? { code: "MCP_FIELD_CONFLICT", fields } : undefined)
    if (!fields.length) setStore("error", "")
  }

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
    if (
      !canSaveMcp({
        mode: props.mode,
        state: state(),
        busy: store.busy,
        writable: props.mode === "edit" ? configQuery.data?.writable : true,
        conflict: store.conflict,
        saved: store.saved,
      })
    )
      return
    const ticket = { generation: generation(), operation: operation() + 1, identity: currentIdentity() }
    setOperation(ticket.operation)
    setStore("busy", true)
    setStore("error", "")
    const config = mergeMcpConfig(existing(), store)
    try {
      const context = sdk()
      const scope = serverSDK().scope
      if (props.mode === "edit") {
        const source = configQuery.data
        if (!source) {
          if (owns(ticket)) setStore("busy", false)
          return
        }
        await context.client.config.updateMcp(
          {
            name,
            directory: context.directory,
            source: source.source,
            version: source.version,
            patch: {
              ...(store.touched.kind ? { type: store.kind } : {}),
              ...(store.kind === "local" && (store.touched.command || store.touched.kind)
                ? { command: config.command }
                : {}),
              ...(store.kind === "remote" && (store.touched.url || store.touched.kind) ? { url: config.url } : {}),
            },
          },
          { throwOnError: true },
        )
      } else {
        await serverSync().updateConfig({ mcp: { [name]: config } })
      }
      const committed = owns(ticket)
      if (committed) setStore("saved", true)
      try {
        await refreshSavedConfig(scope, context.directory)
        if (committed) finishOwnedSave(ticket)
      } catch (refresh) {
        if (!owns(ticket)) return
        const message = refresh instanceof Error ? refresh.message : String(refresh)
        setStore("refreshError", message || language.t("settings.mcp.error.refresh"))
      }
    } catch (error) {
      if (!owns(ticket)) return
      const code = mcpErrorCode(error)
      const ref = mcpErrorRef(error)
      const message = mcpFailureMessage(code, language.t, error)
      setStore("error", ref ? `${message} (${ref})` : message)
      if (code === "MCP_VERSION_CONFLICT" || code === "MCP_SOURCE_CHANGED") {
        setStore("conflict", { code, ref, fields: [] })
      }
      showToast({ title: language.t("common.requestFailed"), description: message })
    } finally {
      if (owns(ticket)) setStore("busy", false)
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
              onInput={(event) => {
                setStore("touched", "name", true)
                setStore("name", event.currentTarget.value)
              }}
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
              onSelect={(option) => {
                if (!option) return
                setStore("touched", "kind", true)
                setStore("kind", option)
              }}
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
                onInput={(event) => {
                  setStore("touched", "command", true)
                  setStore("command", event.currentTarget.value)
                }}
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
                onInput={(event) => {
                  setStore("touched", "url", true)
                  setStore("url", event.currentTarget.value)
                }}
              />
            </div>
          </Show>
          <Show when={state() === "pending"}>
            <span class="settings-v2-server-dialog-error">{language.t("settings.mcp.loading")}</span>
          </Show>
          <Show when={state() === "error"}>
            <span class="settings-v2-server-dialog-error">{language.t("settings.mcp.error.load")}</span>
            <ButtonV2 variant="ghost-muted" onClick={() => setRequest((current) => current + 1)}>
              {language.t("settings.mcp.retry")}
            </ButtonV2>
          </Show>
          <Show when={props.mode === "edit" && configQuery.data && !configQuery.data.writable}>
            <span class="settings-v2-server-dialog-error">{language.t("settings.mcp.error.readOnly")}</span>
          </Show>
          <Show when={state() === "missing"}>
            <span class="settings-v2-server-dialog-error">{language.t("settings.mcp.error.missing")}</span>
          </Show>
          <Show when={store.error}>
            <span class="settings-v2-server-dialog-error">{store.error}</span>
          </Show>
          <Show when={store.refreshError}>
            <span class="settings-v2-server-dialog-error">
              {store.refreshError || language.t("settings.mcp.error.refresh")}
            </span>
            <ButtonV2 variant="ghost-muted" disabled={store.busy} onClick={() => void retryRefresh()}>
              {language.t("settings.mcp.refresh")}
            </ButtonV2>
          </Show>
          <Show when={store.conflict}>
            <ButtonV2 variant="ghost-muted" disabled={store.busy} onClick={() => void reloadLatest()}>
              {language.t("settings.mcp.reload")}
            </ButtonV2>
          </Show>
          <Show when={store.conflict?.fields.includes("kind")}>
            <ButtonV2 variant="ghost-muted" onClick={() => chooseField("kind", "latest")}>
              {language.t("settings.mcp.field.type")}
            </ButtonV2>
          </Show>
          <Show when={store.conflict?.fields.includes("command")}>
            <ButtonV2 variant="ghost-muted" onClick={() => chooseField("command", "latest")}>
              {language.t("settings.mcp.field.command")}
            </ButtonV2>
          </Show>
          <Show when={store.conflict?.fields.includes("url")}>
            <ButtonV2 variant="ghost-muted" onClick={() => chooseField("url", "latest")}>
              {language.t("settings.mcp.field.url")}
            </ButtonV2>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" disabled={store.busy} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          variant="contrast"
          disabled={
            !canSaveMcp({
              mode: props.mode,
              state: state(),
              busy: store.busy,
              writable: props.mode === "edit" ? configQuery.data?.writable : true,
              conflict: store.conflict,
              saved: store.saved,
            })
          }
          onClick={() => void save()}
        >
          {store.busy ? language.t("common.saving") : language.t("common.save")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
