import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { showToast } from "@/utils/toast"
import { type Accessor, type Component, Show } from "solid-js"
import { ProviderRows } from "../settings-provider-rows"
import { useLanguage } from "@/context/language"
import { relayErrorKey, useRelaySettings, vendorURLValid } from "@/hooks/use-relay-settings"
import { SettingsServerPicker, SettingsServerScope } from "../settings-server-picker"
import { SettingsListV2 } from "./parts/list"
import "./settings-v2.css"

const PROVIDER_ICON_SIZE = 16

export const SettingsProvidersV2: Component<{
  directory: Accessor<string | undefined>
  onBack?: () => void
}> = () => {
  return (
    <SettingsServerScope>
      <SettingsProvidersV2Content />
    </SettingsServerScope>
  )
}

const SettingsProvidersV2Content: Component = () => {
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
    <>
      <div class="settings-v2-tab-header">
        <div class="flex items-center justify-between gap-4">
          <h2 class="settings-v2-tab-title">{language.t("settings.providers.title")}</h2>
          <div class="flex items-center gap-2">
            <ButtonV2 onClick={() => void run(relay.reload)}>{language.t("settings.relay.reload")}</ButtonV2>
            <SettingsServerPicker />
          </div>
        </div>
      </div>

      <div class="settings-v2-tab-body settings-v2-providers">
        <Show when={relay.store.error}>
          {(key) => (
            <div class="settings-v2-provider-row">
              <span class="settings-v2-provider-description">{language.t(key())}</span>
              <ButtonV2 size="normal" variant="ghost-muted" onClick={() => void relay.reload()}>
                {language.t("settings.relay.retry")}
              </ButtonV2>
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
          <ButtonV2 onClick={() => void run(relay.reload)}>{language.t("settings.mcp.refresh")}</ButtonV2>
        </Show>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.providers.title")}</h3>
          <SettingsListV2>
            <ProviderRows items={relay.vendors()} by={(vendor) => JSON.stringify([vendor.id, vendor.entityId])}>
              {(vendor) => (
                <fieldset class="contents" data-vendor-id={vendor().id} disabled={!!relay.store.auth && !relay.canEdit()}>
                  <VendorCard vendor={vendor()} relay={relay} run={run} />
                </fieldset>
              )}
            </ProviderRows>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <SettingsListV2>
            <div class="settings-v2-provider-row">
              <div class="settings-v2-provider-copy">
                <span class="settings-v2-provider-name">{language.t("settings.relay.add")}</span>
                <TextInputV2
                  dir="auto"
                  aria-label={language.t("settings.relay.add.name")}
                  value={relay.store.addName}
                  placeholder={language.t("settings.relay.add.name")}
                  onInput={(event) => relay.setStore("addName", event.currentTarget.value)}
                />
                <label class="flex flex-col gap-2">
                  <span class="settings-v2-provider-description">
                    {language.t("provider.custom.field.baseURL.label")}
                  </span>
                  <TextInputV2
                    dir="ltr"
                    placeholder={language.t("provider.custom.field.baseURL.placeholder")}
                    value={relay.store.addURL}
                    onInput={(event) => relay.setStore("addURL", event.currentTarget.value)}
                  />
                </label>
                <TextInputV2
                  type="password"
                  aria-label={language.t("settings.relay.key.placeholder")}
                  value={relay.store.addKey}
                  placeholder={language.t("settings.relay.key.placeholder")}
                  onInput={(event) => relay.setStore("addKey", event.currentTarget.value)}
                />
              </div>
              <ButtonV2
                size="normal"
                variant="neutral"
                icon="plus"
                disabled={
                  relay.store.adding ||
                  (!!relay.store.auth && !relay.canAdd()) ||
                  (!relay.store.addUnconfirmed &&
                    (!relay.store.addName.trim() || !vendorURLValid(relay.store.addURL) || !relay.store.addKey.trim()))
                }
                onClick={() => void run(relay.addVendor)}
              >
                {language.t(relay.store.addUnconfirmed ? "settings.relay.retry" : "settings.relay.add")}
              </ButtonV2>
            </div>
          </SettingsListV2>
        </div>
      </div>
    </>
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
    <details class="settings-v2-relay-card">
      <summary class="settings-provider-summary settings-v2-provider-row">
        <div class="settings-v2-provider-lead">
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
            width={PROVIDER_ICON_SIZE}
            height={PROVIDER_ICON_SIZE}
            class="settings-v2-provider-icon shrink-0"
          />
          <div class="settings-v2-provider-copy">
            <div class="settings-v2-provider-main">
              <bdi dir="auto" class="settings-v2-provider-name truncate">
                {props.vendor.name}
              </bdi>
              <Show when={hasKey()}>
                <Tag>{language.t("settings.relay.key.set")}</Tag>
              </Show>
            </div>
            <p class="settings-v2-provider-description">
              {language.t("settings.relay.models.visible", { count: props.relay.visibleCount(props.vendor.id) })}
            </p>
            <Show when={status() === "connected"}>
              <p class="settings-v2-provider-description">
                {language.t("settings.relay.connected", {
                  count: props.relay.vendorCandidates(props.vendor.id).length,
                })}
              </p>
            </Show>
            <Show when={status() === "empty"}>
              <p class="settings-v2-provider-description">{language.t("settings.relay.connectedEmpty")}</p>
            </Show>
          </div>
        </div>
      </summary>

      <div class="settings-v2-relay-editor">
        <TextInputV2
          dir="auto"
          aria-label={language.t("settings.relay.add.name")}
          value={draft().name}
          invalid={draft().conflicts.includes("name")}
          onInput={(event) => props.relay.setDraft(props.vendor.id, "name", event.currentTarget.value)}
        />
        <label class="flex flex-col gap-2">
          <span class="settings-v2-provider-description">{language.t("provider.custom.field.baseURL.label")}</span>
          <TextInputV2
            dir="ltr"
            placeholder={language.t("provider.custom.field.baseURL.placeholder")}
            value={draft().baseURL}
            invalid={draft().conflicts.includes("baseURL")}
            onInput={(event) => props.relay.setDraft(props.vendor.id, "baseURL", event.currentTarget.value)}
          />
        </label>
        <TextInputV2
          type="password"
          value={draft().key}
          placeholder={
            props.vendor.hasKey ? language.t("settings.relay.key.keep") : language.t("settings.relay.key.placeholder")
          }
          onInput={(event) => props.relay.setDraft(props.vendor.id, "key", event.currentTarget.value)}
        />
        <div class="settings-v2-relay-actions">
          <ButtonV2
            size="normal"
            variant="neutral"
            onClick={() => void props.run(() => props.relay.saveVendor(props.vendor))}
          >
            {language.t("common.save")}
          </ButtonV2>
          <ButtonV2
            size="normal"
            variant="ghost-muted"
            disabled={props.relay.isBusy("fetching", props.vendor.id)}
            onClick={() => void props.run(() => props.relay.fetchModels(props.vendor.id))}
          >
            {props.relay.isBusy("fetching", props.vendor.id)
              ? language.t("settings.relay.fetching")
              : language.t("settings.relay.fetch")}
          </ButtonV2>
          <ButtonV2
            size="normal"
            variant="ghost-muted"
            disabled={!props.relay.store.auth || !props.vendor.hasKey}
            onClick={() => void props.run(() => props.relay.clearVendorKey(props.vendor))}
          >
            {language.t("settings.relay.clearKey")}
          </ButtonV2>
          <ButtonV2
            size="normal"
            variant="ghost-muted"
            onClick={() => void props.run(() => props.relay.deleteVendor(props.vendor))}
          >
            {language.t("settings.relay.delete")}
          </ButtonV2>
        </div>
        <span class="settings-v2-provider-name">
          {language.t("settings.relay.models.title", { vendor: props.vendor.name })}
        </span>
        <Show
          when={props.relay.vendorCandidates(props.vendor.id).length > 0}
          fallback={<p class="settings-v2-provider-description">{language.t("settings.relay.models.empty")}</p>}
        >
          <div class="settings-provider-models">
            <div class="settings-provider-model-grid">
              <ProviderRows items={props.relay.vendorCandidates(props.vendor.id)} by={(item) => item.modelId}>
                {(item) => (
                  <CheckboxV2
                    checked={props.relay.isVisible(props.vendor.id, item().modelId)}
                    onChange={(checked) =>
                      void props.run(() => props.relay.setVisible(props.vendor.id, item().modelId, checked))
                    }
                    label={
                      <span class="flex items-center gap-2">
                        <bdi dir="auto">{item().displayName ?? item().modelId}</bdi>
                        <Show when={!item().upstreamPresent}>
                          <Tag>{language.t("settings.relay.models.missing")}</Tag>
                        </Show>
                      </span>
                    }
                  />
                )}
              </ProviderRows>
            </div>
          </div>
        </Show>
      </div>
    </details>
  )
}
