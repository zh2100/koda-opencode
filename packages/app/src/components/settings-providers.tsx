import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Tag } from "@opencode-ai/ui/tag"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@/utils/toast"
import { type Component, Show } from "solid-js"
import { ProviderRows } from "./settings-provider-rows"
import { useLanguage } from "@/context/language"
import { relayErrorKey, useRelaySettings, vendorURLValid } from "@/hooks/use-relay-settings"
import { SettingsList } from "./settings-list"
import { SettingsServerPicker, SettingsServerScope } from "./settings-server-picker"

export const SettingsProviders: Component<{ onBack?: () => void }> = () => {
  return (
    <SettingsServerScope>
      <SettingsProvidersContent />
    </SettingsServerScope>
  )
}

const SettingsProvidersContent: Component = () => {
  const language = useLanguage()
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
          <div class="flex items-center gap-2">
            <Button onClick={() => void run(relay.reload)}>{language.t("settings.relay.reload")}</Button>
            <SettingsServerPicker />
          </div>
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

        <Show when={relay.store.auth && !relay.canEdit()}>
          <p role="status">{language.t("settings.relay.unsupported")}</p>
        </Show>
        <Show when={relay.store.addUnconfirmed}>
          <p role="status">{language.t("settings.relay.addPending")}</p>
        </Show>
        <Show when={relay.store.addTargetChanged}>
          <p role="status">{language.t("settings.relay.addTargetChanged")}</p>
        </Show>
        <Show when={relay.store.catalogPending || relay.store.refreshPending || relay.store.visibilityPending}>
          <p role="status">{language.t("settings.mcp.error.refresh")}</p>
        </Show>
        <Show
          when={
            relay.store.catalogPending ||
            relay.store.refreshPending ||
            relay.store.visibilityPending ||
            relay.store.notice === "exhausted"
          }
        >
          <Button onClick={() => void run(relay.reload)}>{language.t("settings.mcp.refresh")}</Button>
        </Show>

        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.providers.title")}</h3>
          <SettingsList>
            <ProviderRows items={relay.vendors()} by={(vendor) => JSON.stringify([vendor.id, vendor.entityId])}>
              {(vendor) => (
                <fieldset class="contents" data-vendor-id={vendor().id} disabled={!!relay.store.auth && !relay.canEdit()}>
                  <VendorCard vendor={vendor()} relay={relay} run={run} />
                </fieldset>
              )}
            </ProviderRows>
          </SettingsList>
        </div>

        <SettingsList>
          <div class="flex flex-col gap-3 py-3">
            <span class="text-14-medium text-text-strong">{language.t("settings.relay.add")}</span>
            <TextField
              dir="auto"
              label={language.t("settings.relay.add.name")}
              value={relay.store.addName}
              placeholder={language.t("settings.relay.add.name")}
              onChange={(value) => relay.setStore("addName", value)}
            />
            <TextField
              label={language.t("provider.custom.field.baseURL.label")}
              placeholder={language.t("provider.custom.field.baseURL.placeholder")}
              dir="ltr"
              value={relay.store.addURL}
              onChange={(value) => relay.setStore("addURL", value)}
            />
            <TextField
              type="password"
              label={language.t("settings.relay.key.placeholder")}
              value={relay.store.addKey}
              placeholder={language.t("settings.relay.key.placeholder")}
              onChange={(value) => relay.setStore("addKey", value)}
            />
            <Button
              size="large"
              variant="secondary"
              icon="plus-small"
              disabled={
                relay.store.adding ||
                (!!relay.store.auth && !relay.canAdd()) ||
                (!relay.store.addUnconfirmed &&
                  (!relay.store.addName.trim() || !vendorURLValid(relay.store.addURL) || !relay.store.addKey.trim()))
              }
              onClick={() => void run(relay.addVendor)}
            >
              {language.t(relay.store.addUnconfirmed ? "settings.relay.retry" : "settings.relay.add")}
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
  const hasKey = () => props.vendor.hasKey
  const draft = () => props.relay.draft(props.vendor)
  const status = () => props.relay.store.status[props.vendor.id]

  return (
    <details class="py-3">
      <summary class="settings-provider-summary flex items-center gap-4 py-2">
        <div class="flex items-center gap-3 min-w-0">
          <ProviderIcon
            id={
              props.vendor.id === "chatgpt"
                ? "openai"
                : props.vendor.id === "claude"
                  ? "anthropic"
                  : props.vendor.id === "gemini"
                    ? "google"
                    : props.vendor.id === "grok"
                      ? "xai"
                      : props.vendor.id === "kimi"
                        ? "moonshot"
                        : props.vendor.id
            }
            class="size-5 shrink-0 icon-strong-base"
          />
          <div class="flex min-w-0 flex-col gap-1">
            <div class="flex flex-wrap items-center gap-2">
              <bdi dir="auto" class="text-14-medium text-text-strong truncate">
                {props.vendor.name}
              </bdi>
              <Show when={hasKey()}>
                <Tag>{language.t("settings.relay.key.set")}</Tag>
              </Show>
            </div>
            <span class="text-12-regular text-text-weak">
              {language.t("settings.relay.models.visible", { count: props.relay.visibleCount(props.vendor.id) })}
            </span>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
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
        </div>
      </summary>

      <div class="flex flex-col gap-3 border-t border-border-weak-base pt-3 ps-8">
        <div class="flex w-[280px] max-w-full flex-col gap-3">
          <TextField
            dir="auto"
            label={language.t("settings.relay.add.name")}
            value={draft().name}
            validationState={draft().conflicts.includes("name") ? "invalid" : undefined}
            onChange={(value) => props.relay.setDraft(props.vendor.id, "name", value)}
          />
          <TextField
            label={language.t("provider.custom.field.baseURL.label")}
            placeholder={language.t("provider.custom.field.baseURL.placeholder")}
            dir="ltr"
            value={draft().baseURL}
            validationState={draft().conflicts.includes("baseURL") ? "invalid" : undefined}
            onChange={(value) => props.relay.setDraft(props.vendor.id, "baseURL", value)}
          />
          <TextField
            type="password"
            value={draft().key}
            placeholder={language.t(props.vendor.hasKey ? "settings.relay.key.keep" : "settings.relay.key.placeholder")}
            onChange={(value) => props.relay.setDraft(props.vendor.id, "key", value)}
          />
        </div>
        <div class="flex flex-wrap gap-2">
          <Button
            size="large"
            variant="secondary"
            onClick={() => void props.run(() => props.relay.saveVendor(props.vendor))}
          >
            {language.t("common.save")}
          </Button>
          <Button
            size="large"
            variant="ghost"
            disabled={props.relay.isBusy("fetching", props.vendor.id)}
            onClick={() => void props.run(() => props.relay.fetchModels(props.vendor.id))}
          >
            {props.relay.isBusy("fetching", props.vendor.id)
              ? language.t("settings.relay.fetching")
              : language.t("settings.relay.fetch")}
          </Button>
          <Button
            size="large"
            variant="ghost"
            disabled={!props.relay.store.auth || !props.vendor.hasKey}
            onClick={() => void props.run(() => props.relay.clearVendorKey(props.vendor))}
          >
            {language.t("settings.relay.clearKey")}
          </Button>
          <Button
            size="large"
            variant="ghost"
            onClick={() => void props.run(() => props.relay.deleteVendor(props.vendor))}
          >
            {language.t("settings.relay.delete")}
          </Button>
        </div>
        <div class="flex flex-col gap-2">
          <span class="text-14-medium text-text-strong">
            {language.t("settings.relay.models.title", { vendor: props.vendor.name })}
          </span>
          <Show
            when={props.relay.vendorCandidates(props.vendor.id).length > 0}
            fallback={<span class="text-12-regular text-text-weak">{language.t("settings.relay.models.empty")}</span>}
          >
            <div class="settings-provider-models">
              <div class="settings-provider-model-grid">
                <ProviderRows items={props.relay.vendorCandidates(props.vendor.id)} by={(item) => item.modelId}>
                  {(item) => (
                    <Checkbox
                      checked={props.relay.isVisible(props.vendor.id, item().modelId)}
                      onChange={(checked) =>
                        void props.run(() => props.relay.setVisible(props.vendor.id, item().modelId, checked))
                      }
                    >
                      <span class="flex items-center gap-2">
                        <bdi dir="auto">{item().displayName ?? item().modelId}</bdi>
                        <Show when={!item().upstreamPresent}>
                          <Tag>{language.t("settings.relay.models.missing")}</Tag>
                        </Show>
                      </span>
                    </Checkbox>
                  )}
                </ProviderRows>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </details>
  )
}
