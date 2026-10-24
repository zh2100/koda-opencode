import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { SettingsList } from "./settings-list"
import { SettingsRowV2 } from "./settings-v2/parts/row"

const scopes = ["any", "chrome", "excel"] as const

export const SettingsComputerUse: Component = () => {
  const language = useLanguage()
  const settings = useSettings()
  const options = () =>
    scopes.map((scope) => ({
      value: scope,
      label: language.t(`settings.computerUse.scope.${scope}`),
    }))

  return (
    <div class="flex flex-col gap-6 px-4 py-6 sm:px-10">
      <div class="flex flex-col gap-1 max-w-[720px]">
        <h2 class="text-16-medium text-text-strong">{language.t("settings.computerUse.title")}</h2>
        <p class="text-12-regular text-text-weak">{language.t("settings.computerUse.description")}</p>
      </div>
      <SettingsList>
        <SettingsRowV2
          title={language.t("settings.computerUse.enabled")}
          description={language.t("settings.computerUse.enabled.description")}
        >
          <Switch
            checked={settings.computerUse.enabled()}
            disabled={!settings.computerUse.ready()}
            onChange={(checked) => settings.computerUse.setEnabled(checked)}
          />
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.computerUse.scope")}
          description={language.t("settings.computerUse.scope.description")}
        >
          <Select
            options={options()}
            current={options().find((item) => item.value === settings.computerUse.scope())}
            value={(item) => item.value}
            label={(item) => item.label}
            onSelect={(item) => item && settings.computerUse.setScope(item.value)}
          />
        </SettingsRowV2>
      </SettingsList>
    </div>
  )
}
