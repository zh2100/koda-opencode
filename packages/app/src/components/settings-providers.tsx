import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Switch } from "@opencode-ai/ui/switch"
import { Tag } from "@opencode-ai/ui/tag"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@/utils/toast"
import { type Component, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { relayErrorKey, useRelaySettings } from "@/hooks/use-relay-settings"
import { SettingsList } from "./settings-list"
import { SettingsServerPicker, SettingsServerScope } from "./settings-server-picker"

const UPSTREAM = "https://api.leidiandonghua.cn/v1"

export const SettingsProviders: Component<{ onBack?: () => void }> = () => {
  return (
    <SettingsServerScope>
      <SettingsProvidersContent />
    </SettingsServerScope>
  )
}

const SettingsProvidersContent: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const relay = useRelaySettings()

  const run = async (action: () => Promise<void>) => {
    try {
      await action()
    } catch (error) {
      showToast({
        title: language.t("common.requestFailed"),
        description: language.t(relayErrorKey(error)),
      })
    }
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex items-center justify-between gap-4 pt-6 pb-8 max-w-[720px]">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.providers.title")}</h2>
          <SettingsServerPicker />
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        <Show when={relay.store.error}>
          {(key) => (
            <div class="flex items-center justify-between gap-4">
              <span class="text-14-regular text-text-weak">{language.t(key())}</span>
              <Button size="large" variant="ghost" onClick={() => void relay.reload()}>
                {language.t("settings.relay.retry")}
              </Button>
            </div>
          )}
        </Show>

        <SettingsList>
          <div class="flex flex-wrap items-center justify-between gap-4 min-h-16 py-3 border-b border-border-weak-base">
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="text-14-medium text-text-strong">{language.t("settings.relay.unified")}</span>
              <span class="text-12-regular text-text-weak">{language.t("settings.relay.unified.description")}</span>
            </div>
            <Switch
              checked={relay.store.auth?.unified ?? false}
              onChange={(checked) => void run(() => relay.setMode(checked))}
              hideLabel
            >
              {language.t("settings.relay.unified")}
            </Switch>
          </div>
          <div class="flex flex-col gap-3 py-3 border-b border-border-weak-base">
            <span class="text-14-medium text-text-strong">{language.t("settings.relay.unified.key")}</span>
            <TextField
              type="password"
              label={language.t("settings.relay.unified.key")}
              hideLabel
              value={relay.store.unifiedKey}
              placeholder={language.t("settings.relay.key.placeholder")}
              description={
                relay.store.auth?.hasUnifiedKey
                  ? language.t("settings.relay.key.keep")
                  : language.t("settings.relay.key.placeholder")
              }
              onChange={(value) => relay.setStore("unifiedKey", value)}
            />
            <div class="flex flex-wrap gap-2">
              <Button size="large" variant="secondary" onClick={() => void run(relay.saveUnified)}>
                {language.t("common.save")}
              </Button>
              <Show when={relay.store.auth?.hasUnifiedKey}>
                <Button size="large" variant="ghost" onClick={() => void run(relay.clearUnified)}>
                  {language.t("settings.relay.clearKey")}
                </Button>
              </Show>
            </div>
          </div>
          <div class="py-3">
            <span class="text-12-regular text-text-weak">
              {language.t("settings.relay.upstream")}: <bdi dir="ltr">{UPSTREAM}</bdi>
            </span>
          </div>
        </SettingsList>

        <Show when={relay.store.auth?.canRollback}>
          <SettingsList>
            <div class="flex items-center justify-between gap-4 py-3">
              <div class="flex min-w-0 flex-col gap-1">
                <span class="text-14-medium text-text-strong">{language.t("settings.relay.rollback")}</span>
                <span class="text-12-regular text-text-weak">{language.t("settings.relay.rollback.description")}</span>
              </div>
              <Button size="large" variant="ghost" onClick={() => void run(relay.rollback)}>
                {language.t("common.reset")}
              </Button>
            </div>
          </SettingsList>
        </Show>

        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.relay.title")}</h3>
          <div class="flex flex-wrap items-center gap-3 pb-2">
            <Button size="large" variant="secondary" onClick={() => platform.openExternal("https://api.leidiandonghua.cn/console/token")}>
              {language.t("settings.relay.getKey")}
            </Button>
            <p class="text-12-regular text-text-weak">{language.t("settings.relay.getKey.description")}</p>
          </div>
          <SettingsList>
            <For each={relay.store.auth?.vendors ?? []}>
              {(vendor) => (
                <VendorCard vendor={vendor} relay={relay} run={run} />
              )}
            </For>
          </SettingsList>
        </div>

        <SettingsList>
          <div class="flex flex-col gap-3 py-3">
            <span class="text-14-medium text-text-strong">{language.t("settings.relay.add")}</span>
            <TextField
              value={relay.store.addName}
              placeholder={language.t("settings.relay.add.name")}
              onChange={(value) => relay.setStore("addName", value)}
            />
            <TextField
              type="password"
              value={relay.store.addKey}
              placeholder={language.t("settings.relay.key.placeholder")}
              onChange={(value) => relay.setStore("addKey", value)}
            />
            <Button size="large" variant="secondary" icon="plus-small" onClick={() => void run(relay.addVendor)}>
              {language.t("settings.relay.add")}
            </Button>
          </div>
        </SettingsList>
      </div>
    </div>
  )
}

const VendorCard: Component<{
  vendor: NonNullable<ReturnType<typeof useRelaySettings>["store"]["auth"]>["vendors"][number]
  relay: ReturnType<typeof useRelaySettings>
  run: (action: () => Promise<void>) => Promise<void>
}> = (props) => {
  const language = useLanguage()
  const unified = () => props.relay.store.auth?.unified ?? false
  const hasKey = () => (unified() ? props.relay.store.auth?.hasUnifiedKey : props.vendor.hasKey)
  const draft = () => props.relay.draft(props.vendor)
  const status = () => props.relay.store.status[props.vendor.id]
  const open = () => props.relay.store.open === props.vendor.id

  return (
    <div class="flex flex-col gap-3 py-3 border-b border-border-weak-base last:border-none">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div class="flex items-center gap-3 min-w-0">
          <ProviderIcon id={props.vendor.id} class="size-5 shrink-0 icon-strong-base" />
          <span class="text-14-medium text-text-strong truncate">{props.vendor.name}</span>
          <Show when={props.vendor.builtin}>
            <Tag>{language.t("settings.relay.builtin")}</Tag>
          </Show>
          <Show when={hasKey()}>
            <Tag>{language.t("settings.relay.key.set")}</Tag>
          </Show>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-12-regular text-text-weak">
            {language.t("settings.relay.models.visible", { count: props.relay.visibleCount(props.vendor.id) })}
          </span>
          <Show when={status() === "connected"}>
            <span class="text-12-regular text-text-weak">
              {language.t("settings.relay.connected", {
                count: props.relay.vendorCandidates(props.vendor.id).length,
              })}
            </span>
          </Show>
          <Show when={status() === "empty"}>
            <span class="text-12-regular text-text-weak">{language.t("settings.relay.connectedEmpty")}</span>
          </Show>
          <Button
            size="large"
            variant="ghost"
            onClick={() => props.relay.setStore("open", open() ? undefined : props.vendor.id)}
          >
            {language.t("settings.relay.edit")}
          </Button>
        </div>
      </div>

      <Show when={open()}>
        <div class="flex flex-col gap-3 ps-8">
          <TextField
            value={draft().name}
            onChange={(value) => props.relay.setDraft(props.vendor.id, "name", value)}
          />
          <Show
            when={!unified()}
            fallback={<span class="text-12-regular text-text-weak">{language.t("settings.relay.unified.using")}</span>}
          >
            <TextField
              type="password"
              value={draft().key}
              placeholder={language.t("settings.relay.key.placeholder")}
              description={props.vendor.hasKey ? language.t("settings.relay.key.keep") : undefined}
              onChange={(value) => props.relay.setDraft(props.vendor.id, "key", value)}
            />
          </Show>
          <div class="flex flex-wrap gap-2">
            <Button size="large" variant="secondary" onClick={() => void props.run(() => props.relay.saveVendor(props.vendor))}>
              {language.t("common.save")}
            </Button>
            <Button
              size="large"
              variant="ghost"
              disabled={props.relay.store.testing === props.vendor.id}
              onClick={() =>
                void props.run(async () => {
                  const status = await props.relay.probe(props.vendor.id)
                  showToast({
                    title:
                      status === "connected"
                        ? language.t("settings.relay.test.ok")
                        : language.t("settings.relay.test.empty"),
                  })
                })
              }
            >
              {props.relay.store.testing === props.vendor.id
                ? language.t("settings.relay.testing")
                : language.t("settings.relay.test")}
            </Button>
            <Button
              size="large"
              variant="ghost"
              disabled={props.relay.store.fetching === props.vendor.id}
              onClick={() => void props.run(() => props.relay.fetchModels(props.vendor.id))}
            >
              {props.relay.store.fetching === props.vendor.id
                ? language.t("settings.relay.fetching")
                : language.t("settings.relay.fetch")}
            </Button>
            <Show when={!unified() && props.vendor.hasKey}>
              <Button size="large" variant="ghost" onClick={() => void props.run(() => props.relay.clearVendorKey(props.vendor))}>
                {language.t("settings.relay.clearKey")}
              </Button>
            </Show>
            <Show when={!props.vendor.builtin}>
              <Button size="large" variant="ghost" onClick={() => void props.run(() => props.relay.deleteVendor(props.vendor))}>
                {language.t("settings.relay.delete")}
              </Button>
            </Show>
          </div>
          <div class="flex flex-col gap-2">
            <span class="text-14-medium text-text-strong">
              {language.t("settings.relay.models.title", { vendor: props.vendor.name })}
            </span>
            <Show
              when={props.relay.vendorCandidates(props.vendor.id).length > 0}
              fallback={<span class="text-12-regular text-text-weak">{language.t("settings.relay.models.empty")}</span>}
            >
              <For each={props.relay.vendorCandidates(props.vendor.id)}>
                {(item) => (
                  <Checkbox
                    checked={props.relay.isVisible(props.vendor.id, item.modelId)}
                    onChange={(checked) =>
                      void props.run(() => props.relay.setVisible(props.vendor.id, item.modelId, checked))
                    }
                  >
                    <span class="flex items-center gap-2">
                      <bdi dir="auto">{item.displayName ?? item.modelId}</bdi>
                      <Show when={!item.upstreamPresent}>
                        <Tag>{language.t("settings.relay.models.missing")}</Tag>
                      </Show>
                    </span>
                  </Checkbox>
                )}
              </For>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}
