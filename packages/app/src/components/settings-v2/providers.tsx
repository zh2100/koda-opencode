import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { showToast } from "@/utils/toast"
import { type Accessor, type Component, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { relayErrorKey, useRelaySettings } from "@/hooks/use-relay-settings"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

const PROVIDER_ICON_SIZE = 16
const UPSTREAM = "https://api.leidiandonghua.cn/v1"

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

        <div class="settings-v2-section">
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.relay.unified")}
              description={language.t("settings.relay.unified.description")}
            >
              <Switch
                checked={relay.store.auth?.unified ?? false}
                onChange={(checked) => void run(() => relay.setMode(checked))}
                hideLabel
              >
                {language.t("settings.relay.unified")}
              </Switch>
            </SettingsRowV2>
            <div class="settings-v2-provider-row">
              <div class="settings-v2-provider-copy">
                <span class="settings-v2-provider-name">{language.t("settings.relay.unified.key")}</span>
                <TextInputV2
                  type="password"
                  value={relay.store.unifiedKey}
                  placeholder={language.t("settings.relay.key.placeholder")}
                  onInput={(event) => relay.setStore("unifiedKey", event.currentTarget.value)}
                />
                <Show when={relay.store.auth?.hasUnifiedKey}>
                  <p class="settings-v2-provider-description">{language.t("settings.relay.key.keep")}</p>
                </Show>
              </div>
              <div class="settings-v2-relay-actions">
                <ButtonV2 size="normal" variant="neutral" onClick={() => void run(relay.saveUnified)}>
                  {language.t("common.save")}
                </ButtonV2>
                <Show when={relay.store.auth?.hasUnifiedKey}>
                  <ButtonV2 size="normal" variant="ghost-muted" onClick={() => void run(relay.clearUnified)}>
                    {language.t("settings.relay.clearKey")}
                  </ButtonV2>
                </Show>
              </div>
            </div>
            <p class="settings-v2-provider-description">
              {language.t("settings.relay.upstream")}: <bdi dir="ltr">{UPSTREAM}</bdi>
            </p>
          </SettingsListV2>
        </div>


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
            <ButtonV2 size="normal" variant="neutral" onClick={() => platform.openExternal("https://api.leidiandonghua.cn/console/token")}>
              {language.t("settings.relay.getKey")}
            </ButtonV2>
            <p class="settings-v2-provider-description">{language.t("settings.relay.getKey.description")}</p>
          </div>
          <SettingsListV2>
            <For each={relay.store.auth?.vendors ?? []}>
              {(vendor) => <VendorCard vendor={vendor} relay={relay} run={run} />}
            </For>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <SettingsListV2>
            <div class="settings-v2-provider-row">
              <div class="settings-v2-provider-copy">
                <span class="settings-v2-provider-name">{language.t("settings.relay.add")}</span>
                <TextInputV2
                  value={relay.store.addName}
                  placeholder={language.t("settings.relay.add.name")}
                  onInput={(event) => relay.setStore("addName", event.currentTarget.value)}
                />
                <TextInputV2
                  type="password"
                  value={relay.store.addKey}
                  placeholder={language.t("settings.relay.key.placeholder")}
                  onInput={(event) => relay.setStore("addKey", event.currentTarget.value)}
                />
              </div>
              <ButtonV2 size="normal" variant="neutral" icon="plus" onClick={() => void run(relay.addVendor)}>
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
  const unified = () => props.relay.store.auth?.unified ?? false
  const hasKey = () => (unified() ? props.relay.store.auth?.hasUnifiedKey : props.vendor.hasKey)
  const draft = () => props.relay.draft(props.vendor)
  const status = () => props.relay.store.status[props.vendor.id]
  const open = () => props.relay.store.open === props.vendor.id

  return (
    <div class="settings-v2-relay-card">
      <div class="settings-v2-provider-row">
        <div class="settings-v2-provider-lead">
          <ProviderIcon
            id={props.vendor.id}
            width={PROVIDER_ICON_SIZE}
            height={PROVIDER_ICON_SIZE}
            class="settings-v2-provider-icon shrink-0"
          />
          <div class="settings-v2-provider-copy">
            <div class="settings-v2-provider-main">
              <span class="settings-v2-provider-name truncate">{props.vendor.name}</span>
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
        <ButtonV2
          size="normal"
          variant="ghost-muted"
          onClick={() => props.relay.setStore("open", open() ? undefined : props.vendor.id)}
        >
          {language.t("settings.relay.edit")}
        </ButtonV2>
      </div>

      <Show when={open()}>
        <div class="settings-v2-relay-editor">
          <TextInputV2
            value={draft().name}
            onInput={(event) => props.relay.setDraft(props.vendor.id, "name", event.currentTarget.value)}
          />
          <Show
            when={!unified()}
            fallback={<p class="settings-v2-provider-description">{language.t("settings.relay.unified.using")}</p>}
          >
            <TextInputV2
              type="password"
              value={draft().key}
              placeholder={
                props.vendor.hasKey
                  ? language.t("settings.relay.key.keep")
                  : language.t("settings.relay.key.placeholder")
              }
              onInput={(event) => props.relay.setDraft(props.vendor.id, "key", event.currentTarget.value)}
            />
          </Show>
          <div class="settings-v2-relay-actions">
            <ButtonV2 size="normal" variant="neutral" onClick={() => void props.run(() => props.relay.saveVendor(props.vendor))}>
              {language.t("common.save")}
            </ButtonV2>
            <ButtonV2
              size="normal"
              variant="ghost-muted"
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
            <Show when={!unified() && props.vendor.hasKey}>
              <ButtonV2
                size="normal"
                variant="ghost-muted"
                onClick={() => void props.run(() => props.relay.clearVendorKey(props.vendor))}
              >
                {language.t("settings.relay.clearKey")}
              </ButtonV2>
            </Show>
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
