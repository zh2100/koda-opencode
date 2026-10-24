import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { type Component, createMemo, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useModels } from "@/context/models"
import { useSettings } from "@/context/settings"
import { showToast } from "@/utils/toast"
import { collaborationRoles } from "@/utils/collaboration"
import { SettingsList } from "./settings-list"
import { SettingsRowV2 } from "./settings-v2/parts/row"

type Option = { value: string; label: string }
type Listed = ReturnType<ReturnType<typeof useModels>["list"]>[number]

const modelKey = (providerID: string, modelID: string) => `${providerID}/${modelID}`

const recommend = (items: Listed[]) => {
  const usable = items.filter((item) => item.capabilities.toolcall && item.status !== "deprecated")
  const pool = usable.length ? usable : items
  const worker = pick(pool, (item) => Number(item.capabilities.toolcall) * 4 + output(item) + context(item) / 4)
  const planner =
    pick(pool, (item) => context(item) * 2 + Number(item.capabilities.reasoning) + output(item) / 2) ?? worker
  const reviewer =
    pick(pool, (item) => Number(item.capabilities.reasoning) * 3 + context(item) + output(item) / 2) ?? worker
  return {
    worker: worker ? modelKey(worker.provider.id, worker.id) : "",
    planner: planner && planner !== worker ? modelKey(planner.provider.id, planner.id) : "",
    reviewer: reviewer && reviewer !== worker ? modelKey(reviewer.provider.id, reviewer.id) : "",
    tester: "",
    finalizer: "",
  }
}

const pick = (items: Listed[], score: (item: Listed) => number) =>
  items.reduce<Listed | undefined>((best, item) => (!best || score(item) > score(best) ? item : best), undefined)

const context = (item: Listed) => Math.log10(Math.max(1, item.limit.context))

const output = (item: Listed) => Math.log10(Math.max(1, item.limit.output))

export const SettingsCollaboration: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const modelsCtx = useModels()
  const settings = useSettings()
  const selected = settings.collaboration.models
  const setSelected = settings.collaboration.setModels
  const [testing, setTesting] = createSignal(false)

  const testJev = async () => {
    const url = settings.collaboration.jevUrl().trim()
    const key = settings.collaboration.jevKey()
    if (!url || !key) {
      showToast({
        title: language.t("settings.collaboration.jev.test.failed"),
        description: language.t("settings.collaboration.jev.test.missing"),
      })
      return
    }
    setTesting(true)
    try {
      const response = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          state: "connectivity check",
          model: "jev-latest",
          questions: {
            ok: {
              type: "noul",
              instructions: "Is this a connectivity check?",
            },
          },
        }),
      })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim())
      await response.json()
      showToast({ title: language.t("settings.collaboration.jev.test.ok") })
    } catch (error) {
      showToast({
        title: language.t("settings.collaboration.jev.test.failed"),
        description: error instanceof Error ? error.message : language.t("common.requestFailed"),
      })
    } finally {
      setTesting(false)
    }
  }
  const options = createMemo<Option[]>(() =>
    modelsCtx.list().map((item) => ({
      value: modelKey(item.provider.id, item.id),
      label: `${item.provider.name} / ${item.name}`,
    })),
  )

  return (
    <div class="flex flex-col gap-6 px-4 py-6 sm:px-10">
      <div class="flex flex-col gap-1 max-w-[720px]">
        <h2 class="text-16-medium text-text-strong">{language.t("settings.collaboration.title")}</h2>
        <p class="text-12-regular text-text-weak">{language.t("settings.collaboration.models.description")}</p>
        <button
          type="button"
          class="text-12-regular text-text-interactive w-fit text-left"
          onClick={() => platform.openExternal("https://jevmodel.org/")}
        >
          {language.t("settings.collaboration.jev.apply")}
        </button>
      </div>
      <SettingsList>
        <SettingsRowV2
          title={language.t("settings.collaboration.enabled")}
          description={language.t("settings.collaboration.enabled.description")}
        >
          <Switch
            checked={settings.collaboration.enabled()}
            disabled={!settings.collaboration.preferencesReady()}
            onChange={(checked) => settings.collaboration.setEnabled(checked)}
          />
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.collaboration.jev.url")}
          description={language.t("settings.collaboration.jev.url.description")}
        >
          <TextInputV2
            dir="ltr"
            value={settings.collaboration.jevUrl()}
            onInput={(event) => settings.collaboration.setJevUrl(event.currentTarget.value)}
          />
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.collaboration.jev.key")}
          description={language.t(
            settings.collaboration.jevConfigured()
              ? "settings.collaboration.jev.key.configured"
              : "settings.collaboration.jev.key.description",
          )}
        >
          <TextInputV2
            type="password"
            value={settings.collaboration.jevKey()}
            placeholder={language.t("settings.collaboration.jev.key.placeholder")}
            onInput={(event) => settings.collaboration.setJevKey(event.currentTarget.value)}
          />
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.collaboration.jev.test")}
          description={language.t("settings.collaboration.jev.test.description")}
        >
          <Button
            variant="ghost"
            disabled={testing() || !settings.collaboration.jevUrl().trim() || !settings.collaboration.jevConfigured()}
            onClick={() => void testJev()}
          >
            {language.t(testing() ? "settings.collaboration.jev.test.running" : "settings.collaboration.jev.test")}
          </Button>
        </SettingsRowV2>
      </SettingsList>
      <div class="flex items-center gap-3">
        <Button
          variant="ghost"
          disabled={!settings.collaboration.ready() || !options().length}
          onClick={() => setSelected(recommend(modelsCtx.list()))}
        >
          {language.t("settings.collaboration.recommend")}
        </Button>
        <span class="text-12-regular text-text-weak">{language.t("settings.collaboration.recommend.description")}</span>
      </div>
      <SettingsList>
        {collaborationRoles.map((role) => {
          const choices = () => [
            ...(role === "worker" ? [] : [{ value: "", label: language.t("settings.collaboration.default") }]),
            ...options(),
          ]
          return (
            <SettingsRowV2 title={language.t(`settings.collaboration.${role}`)} description="">
              <Select
                disabled={!settings.collaboration.ready()}
                options={choices()}
                current={choices().find((item) => item.value === (selected[role] ?? ""))}
                value={(item) => item.value}
                label={(item) => item.label}
                onSelect={(item) => setSelected(role, item?.value ?? "")}
              />
            </SettingsRowV2>
          )
        })}
      </SettingsList>
    </div>
  )
}
