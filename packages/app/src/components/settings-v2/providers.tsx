import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { showToast } from "@/utils/toast"
import { type Accessor, type Component, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { relayErrorKey, useRelaySettings, vendorURLValid } from "@/hooks/use-relay-settings"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

const PROVIDER_ICON_SIZE = 16

export const SettingsProvidersV2: Component<{
  directory: Accessor<string | undefined>
  onBack?: () => void
}> = () => {
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
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.providers.title")}</h2>
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

        <Show when={relay.store.auth?.canRollback}>
          <div class="settings-v2-section">
            <SettingsListV2>
              <SettingsRowV2
                title={language.t("settings.relay.rollback")}
                description={language.t("settings.relay.rollback.description")}
              >
                <ButtonV2 size="normal" variant="ghost-muted" onClick={() => void run(relay.rollback)}>
                  {language.t("common.reset")}
                </ButtonV2>
              </SettingsRowV2>
            </SettingsListV2>
          </div>
        </Show>
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.relay.title")}</h3>
          <div class="flex flex-wrap items-center gap-3">
            <ButtonV2
              size="normal"
              variant="neutral"
              onClick={() => platform.openExternal("https://api.leidiandonghua.cn/console/token")}
            >
              {language.t("settings.relay.getKey")}
            </ButtonV2>
            <p class="settings-v2-provider-description">{language.t("settings.relay.getKey.description")}</p>
          </div>
          <SettingsListV2>
            <For each={relay.vendors()}>{(vendor) => <VendorCard vendor={vendor} relay={relay} run={run} />}</For>
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
                  !relay.store.addName.trim() || !vendorURLValid(relay.store.addURL) || !relay.store.addKey.trim()
                }
                onClick={() => void run(relay.addVendor)}
              >
                {language.t("settings.relay.add")}
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
  const collapsible = () => props.vendor.builtin
  const [open, setOpen] = createSignal(false)

  return (
    <div class="settings-v2-relay-card">
      <div class="settings-v2-provider-row">
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
              <Show when={props.vendor.builtin}>
                <Tag>{language.t("settings.relay.builtin")}</Tag>
              </Show>
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
        <Show when={collapsible()}>
          <ButtonV2
            size="normal"
            variant="ghost-muted"
            aria-expanded={open()}
            onClick={() => setOpen((value) => !value)}
          >
            {language.t(open() ? "common.close" : "settings.providers.title")}
          </ButtonV2>
        </Show>
      </div>

      <Show when={!collapsible() || open()}>
      <div class="settings-v2-relay-editor">
        <Show when={!props.vendor.builtin}>
          <TextInputV2
            dir="auto"
            aria-label={language.t("settings.relay.add.name")}
            value={draft().name}
            onInput={(event) => props.relay.setDraft(props.vendor.id, "name", event.currentTarget.value)}
          />
          <label class="flex flex-col gap-2">
            <span class="settings-v2-provider-description">{language.t("provider.custom.field.baseURL.label")}</span>
            <TextInputV2
              dir="ltr"
              placeholder={language.t("provider.custom.field.baseURL.placeholder")}
              value={draft().baseURL}
              onInput={(event) => props.relay.setDraft(props.vendor.id, "baseURL", event.currentTarget.value)}
            />
          </label>
        </Show>
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
            disabled={props.relay.store.fetching === props.vendor.id}
            onClick={() => void props.run(() => props.relay.fetchModels(props.vendor.id))}
          >
            {props.relay.store.fetching === props.vendor.id
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
          <Show when={!props.vendor.builtin}>
            <ButtonV2
              size="normal"
              variant="ghost-muted"
              onClick={() => void props.run(() => props.relay.deleteVendor(props.vendor))}
            >
              {language.t("settings.relay.delete")}
            </ButtonV2>
          </Show>
        </div>
        <span class="settings-v2-provider-name">
          {language.t("settings.relay.models.title", { vendor: props.vendor.name })}
        </span>
        <Show
          when={props.relay.vendorCandidates(props.vendor.id).length > 0}
          fallback={<p class="settings-v2-provider-description">{language.t("settings.relay.models.empty")}</p>}
        >
          <For each={props.relay.vendorCandidates(props.vendor.id)}>
            {(item) => (
              <CheckboxV2
                checked={props.relay.isVisible(props.vendor.id, item.modelId)}
                onChange={(checked) =>
                  void props.run(() => props.relay.setVisible(props.vendor.id, item.modelId, checked))
                }
                label={
                  <span class="flex items-center gap-2">
                    <bdi dir="auto">{item.displayName ?? item.modelId}</bdi>
                    <Show when={!item.upstreamPresent}>
                      <Tag>{language.t("settings.relay.models.missing")}</Tag>
                    </Show>
                  </span>
                }
              />
            )}
          </For>
        </Show>
      </div>
      </Show>
    </div>
  )
}
