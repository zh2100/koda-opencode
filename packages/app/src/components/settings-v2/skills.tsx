import { For, Show, createMemo, createResource, createSignal, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { createQuery } from "@tanstack/solid-query"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useQueryOptions } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { pathKey } from "@/utils/path-key"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type SkillSource = "project" | "global" | "builtin" | "custom"

function skillSource(location: string, directory: string, home: string): SkillSource {
  const file = pathKey(location.replaceAll("\\", "/"))
  if (file.startsWith("/builtin/")) return "builtin"
  const project = pathKey(directory)
  if (project && file.startsWith(`${project}/`)) return "project"
  const root = pathKey(home)
  if (root && file.startsWith(`${root}/`)) return "global"
  return "custom"
}

export const SettingsSkillsV2: Component = () => {
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const sync = useSync()
  const queryOptions = useQueryOptions()
  const skillsQuery = createQuery(() => queryOptions().skills(pathKey(sdk().directory)))
  const projectID = () => sync().project?.id ?? sync().data.project
  const [saved, { refetch: refetchSaved }] = createResource(() =>
    serverSDK().generatedApi.permissions.listSaved({ projectID: projectID() }),
  )
  const [store, setStore] = createStore({ filter: "" })
  const [open, setOpen] = createSignal<string>()

  const denied = (name: string) =>
    saved()?.some((item) => item.action === "skill" && item.resource === name && item.effect === "deny") ?? false

  const toggle = async (name: string, enabled: boolean) => {
    const rule = saved()?.find((item) => item.action === "skill" && item.resource === name)
    if (enabled) {
      if (rule) await serverSDK().generatedApi.permissions.removeSaved({ id: rule.id })
    } else {
      await serverSDK().generatedApi.permissions.add({
        projectID: projectID(),
        action: "skill",
        resource: name,
        effect: "deny",
      })
    }
    await refetchSaved()
  }

  const items = createMemo(() => {
    const list = skillsQuery.data ?? []
    const query = store.filter.trim().toLowerCase()
    if (!query) return list
    return list.filter((skill) => {
      const name = skill.name.toLowerCase()
      const description = (skill.description ?? "").toLowerCase()
      return name.includes(query) || description.includes(query)
    })
  })

  const sourceLabel = (source: SkillSource) => {
    if (source === "project") return language.t("settings.skills.source.project")
    if (source === "global") return language.t("settings.skills.source.global")
    if (source === "builtin") return language.t("settings.skills.source.builtin")
    return language.t("settings.skills.source.custom")
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.skills.title")}</h2>
        <div class="settings-v2-tab-search">
          <TextInputV2
            type="search"
            appearance="base"
            value={store.filter}
            onInput={(event) => setStore("filter", event.currentTarget.value)}
            placeholder={language.t("settings.skills.search")}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            aria-label={language.t("settings.skills.search")}
          />
          <Show when={store.filter}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              class="settings-v2-tab-search-clear"
              icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
              onClick={() => setStore("filter", "")}
            />
          </Show>
        </div>
      </div>
      <div class="settings-v2-tab-body">
        <p class="settings-v2-provider-description">{language.t("settings.skills.description")}</p>
        <Show
          when={!skillsQuery.isPending}
          fallback={
            <div class="settings-v2-provider-empty" role="status">
              {language.t("common.loading")}
              {language.t("common.loading.ellipsis")}
            </div>
          }
        >
          <Show
            when={items().length > 0}
            fallback={
              <div class="settings-v2-provider-empty">
                {store.filter ? language.t("settings.skills.emptySearch") : language.t("settings.skills.empty")}
              </div>
            }
          >
            <SettingsListV2>
              <For each={items()}>
                {(skill) => {
                  const source = () => skillSource(skill.location, sync().data.path.directory, sync().data.path.home)
                  const expanded = () => open() === skill.name
                  return (
                    <div>
                      <SettingsRowV2
                        title={skill.name}
                        description={`${sourceLabel(source())} · ${
                          denied(skill.name)
                            ? language.t("settings.skills.disabled")
                            : language.t("settings.skills.enabled")
                        }`}
                      >
                        <div class="flex items-center gap-2">
                          <IconButtonV2
                            type="button"
                            variant="ghost-muted"
                            size="small"
                            icon={
                              <IconV2
                                name="chevron-down"
                                size="small"
                                class={expanded() ? "rotate-180" : undefined}
                              />
                            }
                            aria-expanded={expanded()}
                            aria-label={language.t("settings.skills.details")}
                            onClick={() => setOpen(expanded() ? undefined : skill.name)}
                          />
                          <Switch
                            checked={!denied(skill.name)}
                            onChange={(checked) => void toggle(skill.name, checked)}
                            hideLabel
                          >
                            {skill.name}
                          </Switch>
                        </div>
                      </SettingsRowV2>
                      <Show when={expanded()}>
                        <div class="settings-v2-provider-description pb-5">
                          <p>{skill.description ?? language.t("settings.skills.noDescription")}</p>
                          <Show when={skill.content.trim()}>
                            <pre class="mt-3 max-h-48 overflow-auto whitespace-pre-wrap text-[12px]" dir="auto">
                              {skill.content.trim()}
                            </pre>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </SettingsListV2>
          </Show>
        </Show>
      </div>
    </>
  )
}
