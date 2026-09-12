import { Show } from "solid-js"
import { createHomeController } from "./home/home-controller"
import { createHomeProjectsController } from "./home/home-projects-controller"
import { createHomeScrollController } from "./home/home-scroll-controller"
import { createHomeSessionSearchController } from "./home/home-session-search-controller"
import { createHomeSessionsController } from "./home/home-sessions-controller"
import { HomeSessions } from "./home/home-sessions"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { useLanguage } from "@/context/language"
import { useSettingsDialog } from "@/components/settings-dialog"
import { useRelayGates } from "@/hooks/use-relay-gates"

export function NewHome() {
  const language = useLanguage()
  const home = createHomeController()
  return (
    <div class="relative size-full overflow-hidden flex flex-col items-center justify-center px-6">
      <div class="flex w-full max-w-[720px] flex-col items-center gap-6">
        <h1 class="text-center text-[28px] leading-9 text-v2-text-text-base [font-weight:530]">
          {language.t("home.welcome.title")}
        </h1>
        <ButtonV2
          data-action="home-new-session"
          variant="neutral"
          size="large"
          icon="edit"
          disabled={!home.project.newSession()}
          onClick={home.project.openNewSession}
        >
          {language.t("command.session.new")}
        </ButtonV2>
      </div>
    </div>
  )
}

export function HomeSessionSidebar() {
  const home = createHomeController()
  const projects = createHomeProjectsController(home)
  const sessions = createHomeSessionsController(home)
  const search = createHomeSessionSearchController(home, sessions)
  const scroll = createHomeScrollController(sessions.data.groups)
  const gates = useRelayGates()
  const openSkills = useSettingsDialog("skills")
  const openMcp = useSettingsDialog("mcp")
  const openScheduled = useSettingsDialog("scheduled")
  const language = projects.copy.language
  return (
    <div class="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-v2-background-bg-base">
      <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <HomeSessions
          sessions={sessions}
          search={search}
          scroll={scroll}
          compact
          afterCreate={
            <div class="mb-2 flex flex-col">
              <Show when={gates().relaySkills}>
                <SidebarNavButton
                  action="home-open-skills"
                  icon="checklist"
                  label={language.t("settings.skills.title")}
                  onClick={openSkills}
                />
              </Show>
              <Show when={gates().relayMcp}>
                <SidebarNavButton
                  action="home-open-mcp"
                  icon="mcp"
                  label={language.t("settings.mcp.title")}
                  onClick={openMcp}
                />
              </Show>
              <Show when={gates().scheduledTasks}>
                <SidebarNavButton
                  action="home-open-scheduled"
                  icon="status"
                  label={language.t("settings.scheduled.title")}
                  onClick={openScheduled}
                />
              </Show>
            </div>
          }
        />
      </div>
      <div class="shrink-0 border-t border-border-weak-base px-2 py-2">
        <SidebarNavButton
          action="home-open-settings"
          icon="settings-gear"
          label={language.t("sidebar.settings")}
          onClick={projects.utility.settings}
        />
      </div>
    </div>
  )
}

function SidebarNavButton(props: {
  action: string
  icon: "checklist" | "mcp" | "status" | "settings-gear"
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-action={props.action}
      class="flex h-8 w-full items-center gap-2 rounded-[6px] px-2 text-start text-[13px] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover [&>[data-slot=icon-svg]]:text-v2-icon-icon-muted"
      onClick={props.onClick}
    >
      <IconV2 name={props.icon} size="small" />
      <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{props.label}</span>
    </button>
  )
}
