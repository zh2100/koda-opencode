import { ServerConnection, useLanguage, useServer, useSettings, useTabs } from "@opencode-ai/app"
import { onMount } from "solid-js"
import { shouldOpenDefaultProject } from "./onboarding-policy"

export function DesktopFirstLaunchOnboarding(props: { initialUrl: string; onLoaded: () => void }) {
  const server = useServer()
  const settings = useSettings()
  const tabs = useTabs()
  const language = useLanguage()

  onMount(() => {
    void runFirstLaunchOnboarding().finally(props.onLoaded)
  })

  async function runFirstLaunchOnboarding() {
    try {
      await Promise.all(
        [server.ready.promise, tabs.ready.promise, tabs.recentReady.promise].map((p) => p ?? Promise.resolve()),
      )
      const existingInstall = await window.api.isOldLayoutEligible()
      settings.general.setOldLayoutEligible(existingInstall)
      settings.general.initializeAgentVisibility(existingInstall)
      if (!server.current || !ServerConnection.builtin(server.current)) return

      const pending = await window.api.isFirstLaunchOnboardingPending()
      if (!pending) return

      const shouldTrigger = shouldOpenDefaultProject({
        builtin: ServerConnection.builtin(server.current),
        initialUrl: props.initialUrl,
        tabs: tabs.store.length,
        projects: server.projects.list().length,
        recentlyClosed: server.projects.recentlyClosed().length,
      })

      console.info("[desktop-onboarding] first launch onboarding evaluated", {
        pending,
        shouldTrigger,
        existingInstall,
        initialUrl: props.initialUrl,
        tabs: tabs.store.length,
        servers: server.list.map(ServerConnection.key),
      })

      const key = server.key
      const directory = await window.api.finishFirstLaunchOnboarding(shouldTrigger).catch(async (error) => {
        console.error("[desktop-onboarding] default directory unavailable", error)
        const selected = await window.api.openDirectoryPicker({
          title: language.t("command.project.openExisting"),
          multiple: false,
        })
        return Array.isArray(selected) ? selected[0] : selected
      })
      if (!shouldTrigger || !directory) return

      // Native directory creation/picking may outlive navigation or server changes.
      if (server.key !== key || tabs.store.length > 0 || server.projects.list().length > 0) return

      console.info("[desktop-onboarding] starting first launch draft", { directory })
      server.projects.open(directory)
      server.projects.touch(directory)
      tabs.select(await tabs.newDraft({ server: server.key, directory }))
    } catch (error) {
      console.error("[desktop-onboarding] first launch onboarding failed", error)
    }
  }

  return null
}
