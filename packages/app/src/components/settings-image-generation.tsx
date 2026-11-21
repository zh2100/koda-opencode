import { ImageGeneration } from "@opencode-ai/schema/image-generation"
import { Button } from "@opencode-ai/ui/button"
import { Option, Schema } from "effect"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { useServerSDK } from "@/context/server-sdk"
import { createImageGenerationSettings } from "./settings-image-generation-state"

const decodeApi = Schema.decodeUnknownOption(ImageGeneration.Api)

export function SettingsImageGeneration() {
  const language = useLanguage()
  const sdk = useServerSDK()
  const state = createImageGenerationSettings(sdk)
  const settings = state.settings

  return (
    <section
      class="flex flex-col gap-3 rounded-lg border border-border-weak-base p-4"
      aria-label={language.t("settings.imageGeneration.title")}
    >
      <h3 class="text-14-medium text-text-strong">{language.t("settings.imageGeneration.title")}</h3>
      <p class="text-12-regular text-text-weak">{language.t("settings.imageGeneration.description")}</p>
      <Show when={!settings.loading && settings()?.server === sdk() && settings()?.error}>
        <p role="alert">{language.t("settings.imageGeneration.loadError")}</p>
        <Button onClick={() => state.reload()}>{language.t("settings.imageGeneration.reload")}</Button>
      </Show>
      <Show when={!settings.loading && settings()?.server === sdk() && !settings()?.error && settings()} keyed>
        {(value) => (
          <ImageGenerationForm config={value.config ?? {}} save={(config) => state.save(value.server, config)} />
        )}
      </Show>
      <Show when={settings.loading}>
        <p role="status">{language.t("common.loading")}</p>
      </Show>
    </section>
  )
}

function ImageGenerationForm(props: {
  config: ImageGeneration.Config
  save: (config: ImageGeneration.Config) => Promise<void>
}) {
  const language = useLanguage()
  const models = useModels()
  const [model, setModel] = createSignal(props.config.model ?? "")
  const [enabled, setEnabled] = createSignal(props.config.enabled === true)
  const [api, setApi] = createSignal<ImageGeneration.Api | "">(props.config.api ?? "")
  const [pending, setPending] = createSignal(false)
  const [status, setStatus] = createSignal<"saved" | "error">()
  const selected = createMemo(() => models.list().find((item) => `${item.provider.id}/${item.id}` === model()))
  const suggested = createMemo(() => {
    const item = selected()
    return item ? ImageGeneration.apiForProvider({ providerID: item.provider.id, npm: item.api.npm }) : undefined
  })
  const hint = createMemo(() => {
    const item = selected()
    if (!item) return "settings.imageGeneration.source.manual" as const
    const source = ImageGeneration.capability({
      id: item.id,
      name: item.name,
      output: item.capabilities.output.image ? ["image"] : [],
    }).source
    return `settings.imageGeneration.source.${source}` as const
  })
  const valid = createMemo(() => !enabled() || (/^[^/\s]+\/\S+$/.test(model().trim()) && api()))
  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    if (pending() || !valid()) return
    setPending(true)
    setStatus(undefined)
    const selectedApi = api()
    const config: ImageGeneration.Config = {
      enabled: enabled(),
      ...(model().trim() ? { model: model().trim() } : {}),
      ...(selectedApi ? { api: selectedApi } : {}),
    }
    await props
      .save(config)
      .then(
        () => setStatus("saved"),
        () => setStatus("error"),
      )
      .finally(() => setPending(false))
  }

  return (
    <form
      class="flex flex-col gap-3 text-14-regular text-text-strong"
      onSubmit={save}
      onInput={() => setStatus(undefined)}
    >
      <fieldset class="flex flex-col gap-3 min-w-0" disabled={pending()}>
        <label class="flex items-center gap-2">
          <input type="checkbox" checked={enabled()} onChange={(event) => setEnabled(event.currentTarget.checked)} />
          {language.t("settings.imageGeneration.enabled")}
        </label>
        <label class="flex flex-col gap-1">
          {language.t("settings.imageGeneration.catalog")}
          <select
            class="rounded border border-border-weak-base bg-surface-base p-2 min-w-0"
            value={selected() ? model() : ""}
            onChange={(event) => {
              const value = event.currentTarget.value
              setModel(value)
              const item = models.list().find((candidate) => `${candidate.provider.id}/${candidate.id}` === value)
              const protocol = item ? ImageGeneration.apiForProvider({ providerID: item.provider.id, npm: item.api.npm }) : undefined
              if (protocol) setApi(protocol)
            }}
          >
            <option value="">{language.t("settings.imageGeneration.manual")}</option>
            <For each={models.list()}>
              {(item) => (
                <option value={`${item.provider.id}/${item.id}`} dir="auto">
                  {item.provider.name} / {item.name}
                </option>
              )}
            </For>
          </select>
        </label>
        <label class="flex flex-col gap-1">
          {language.t("settings.imageGeneration.model")}
          <input
            class="rounded border border-border-weak-base bg-surface-base p-2 w-full"
            dir="ltr"
            value={model()}
            onInput={(event) => setModel(event.currentTarget.value)}
            placeholder="provider/model"
            spellcheck={false}
            autocomplete="off"
          />
        </label>
        <p class="text-12-regular text-text-weak">{language.t(hint())}</p>
        <Show when={model() && !selected()}>
          <p class="text-12-regular text-text-weak">{language.t("settings.imageGeneration.unavailable")}</p>
        </Show>
        <label class="flex flex-col gap-1">
          {language.t("settings.imageGeneration.api")}
          <select
            class="rounded border border-border-weak-base bg-surface-base p-2 min-w-0"
            value={api()}
            onChange={(event) => setApi(Option.getOrElse(decodeApi(event.currentTarget.value), () => ""))}
          >
            <option value="">{language.t("settings.imageGeneration.api.unselected")}</option>
            <For each={ImageGeneration.Api.literals}>
              {(item) => <option value={item}>{language.t(`settings.imageGeneration.api.${item}`)}</option>}
            </For>
          </select>
        </label>
        <Show when={suggested()}>
          {(protocol) => (
            <p class="text-12-regular text-text-weak">
              {language.t("settings.imageGeneration.api.suggested", { api: language.t(`settings.imageGeneration.api.${protocol()}`) })}
            </p>
          )}
        </Show>
        <p class="text-12-regular text-text-weak">{language.t("settings.imageGeneration.warning")}</p>
        <Button type="submit" variant="secondary" disabled={!valid() || pending()}>
          {language.t("settings.imageGeneration.save")}
        </Button>
      </fieldset>
      <Show when={status() === "saved"}>
        <p role="status">{language.t("settings.imageGeneration.saved")}</p>
      </Show>
      <Show when={status() === "error"}>
        <p role="alert">{language.t("settings.imageGeneration.saveError")}</p>
      </Show>
    </form>
  )
}
