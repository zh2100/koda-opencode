import { For, Match, Show, Switch, createEffect, createSignal, type JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import FileTree from "@/components/file-tree"
import { TodoList } from "@/pages/session/composer/session-todo-dock"
import { TerminalPanelV2 } from "@/pages/session/terminal-panel-v2"
import { useSessionLayout } from "@/pages/session/session-layout"
import type { Todo } from "@opencode-ai/sdk/v2"

const tabs = ["files", "changes", "tasks", "terminal"] as const
type Tab = (typeof tabs)[number]

export function SessionRightPanel(props: {
  changes: JSX.Element
  todos: Todo[]
  hasProject: boolean
  git?: { branch?: string; dirty: number }
}) {
  const language = useLanguage()
  const layout = useLayout()
  const session = useSessionLayout()
  const [tab, setTab] = createSignal<Tab>(
    session.view().terminal.opened() ? "terminal" : layout.fileTree.opened() ? "files" : "changes",
  )
  const label = (id: Tab) => {
    if (id === "files") return language.t("session.panel.files")
    if (id === "changes") return language.t("session.panel.changes")
    if (id === "tasks") return language.t("session.panel.tasks")
    return language.t("session.panel.terminal")
  }

  const open = (id: Tab) => {
    setTab(id)
    if (id === "terminal") {
      session.view().terminal.open()
      layout.fileTree.open()
      return
    }
    session.view().terminal.close()
  }

  createEffect(() => {
    if (session.view().terminal.opened()) {
      if (tab() !== "terminal") setTab("terminal")
      return
    }
    if (tab() === "terminal") setTab("files")
  })

  return (
    <aside class="min-w-0 min-h-0 flex-1 flex flex-col bg-v2-background-bg-base rounded-[10px] overflow-hidden">
      <div class="flex h-10 shrink-0 items-center gap-1 px-2 border-b border-border-weak-base">
        <For each={tabs}>
          {(id) => (
            <button
              type="button"
              class="h-7 rounded-sm px-2 text-[13px] font-[530] text-v2-text-text-muted"
              classList={{
                "bg-v2-overlay-simple-overlay-hover text-v2-text-text-base": tab() === id,
              }}
              onClick={() => open(id)}
            >
              {label(id)}
            </button>
          )}
        </For>
      </div>
      <Show
        when={props.hasProject}
        fallback={
          <div class="flex-1 flex items-center justify-center px-4 text-center text-[13px] text-v2-text-text-muted">
            {language.t("session.panel.empty")}
          </div>
        }
      >
        <Switch>
          <Match when={tab() === "files"}>
            <div class="min-h-0 flex-1 overflow-hidden">
              <FileTree path="" class="pt-3" />
            </div>
          </Match>
          <Match when={tab() === "changes"}>
            <div class="min-h-0 flex-1 overflow-hidden flex flex-col">
              <Show when={props.git}>
                {(git) => (
                  <div class="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border-weak-base text-[12px] text-v2-text-text-muted">
                    <Icon name="branch" size="small" />
                    <span class="min-w-0 truncate" dir="auto">
                      {git().branch ?? language.t("session.panel.git.unknown")}
                    </span>
                    <span class="ms-auto shrink-0">
                      {git().dirty > 0
                        ? language.plural("session.panel.git.dirty", git().dirty)
                        : language.t("session.panel.git.clean")}
                    </span>
                  </div>
                )}
              </Show>
              <div class="min-h-0 flex-1 overflow-hidden">{props.changes}</div>
            </div>
          </Match>
          <Match when={tab() === "tasks"}>
            <Show
              when={props.todos.length > 0}
              fallback={
                <div class="flex-1 flex items-center justify-center text-[13px] text-v2-text-text-muted">
                  {language.t("session.todo.empty")}
                </div>
              }
            >
              <div class="min-h-0 flex-1 overflow-y-auto">
                <TodoList todos={props.todos} />
              </div>
            </Show>
          </Match>
          <Match when={tab() === "terminal"}>
            <div class="min-h-0 flex-1 overflow-hidden flex flex-col">
              <TerminalPanelV2 embedded />
            </div>
          </Match>
        </Switch>
      </Show>
    </aside>
  )
}
