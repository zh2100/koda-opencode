import type { Session } from "@opencode-ai/sdk/v2/client"
import { preloadMarkdown } from "@opencode-ai/session-ui/markdown-cache"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useQuery } from "@tanstack/solid-query"
import { type Accessor, createEffect, createMemo, createRoot, type JSX, startTransition } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useCommand } from "@/context/command"
import {
  loadHomeSessionIndex,
  loadHomeSessionIndexV1,
  retainHomeSessions,
  type HomeSessionEvents,
} from "@/context/global-sync/home-session-index"
import type { LocalProject } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import { sessionHasOpenTab, useTabs } from "@/context/tabs"
import { compareSessionTime, displayName, errorMessage, projectForSession } from "@/pages/layout/helpers"
import { useSessionTabAvatarState } from "@/pages/layout/project-avatar-state"
import { pathKey, samePath } from "@/utils/path-key"
import { Persist, persisted } from "@/utils/persist"
import { showToast } from "@/utils/toast"
import { Binary } from "@opencode-ai/core/util/binary"
import { notifySessionTabsRemoved } from "@/components/titlebar-session-events"
import { archiveHomeSession } from "../home-session-archive"
import type { HomeController } from "./home-controller"

const HOME_SESSION_LIMIT = 64
export type HomeSessionRecord = {
  session: Session
  project: LocalProject
  projectName: string
}

export type HomeSessionGroup = {
  id: string
  title: string
  sessions: HomeSessionRecord[]
}

export type OpenSessionOptions = { background?: boolean }

export function createHomeSessionsController(home: HomeController) {
  const tabs = useTabs()
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()
  const projectDirectories = createMemo(() => home.project.list().flatMap(directories))
  const projectByID = createMemo(
    () => new Map(home.project.list().flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
  )
  const homeSessions = () => home.server.focusedSync().homeSessions
  const sessionEventLoad = useQuery(() => ({
    queryKey: homeSessions().eventsKey,
    queryFn: async (): Promise<HomeSessionEvents> => ({ sequence: 0, entries: [] }),
    initialData: { sequence: 0, entries: [] } satisfies HomeSessionEvents,
    staleTime: Infinity,
    enabled: false,
  }))
  const sessionLoad = useQuery(() => ({
    queryKey: homeSessions().indexKey,
    enabled: !!home.server.focusedContext(),
    queryFn: async ({ signal }) => {
      const ctx = home.server.focusedContext()
      if (!ctx) return { sessions: [], eventSequence: 0 }
      const cache = homeSessions()
      const eventSequence = cache.eventSequence()
      const fetched =
        (await ctx.sdk.protocol) === "v1"
          ? await loadHomeSessionIndexV1(
              (input, options) => ctx.sdk.client.experimental.session.list(input, options),
              eventSequence,
              signal,
            )
          : await loadHomeSessionIndex(
              (input, options) => ctx.sdk.client.v2.session.list(input, options),
              eventSequence,
              signal,
            )
      cache.complete(eventSequence)
      return {
        sessions: mergeHomeSessions(fetched.sessions, cache.sessions(fetched, sessionEventLoad.data)),
        eventSequence: fetched.eventSequence,
      }
    },
    retry: false,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnReconnect: true,
  }))
  const localSessions = createMemo(() => {
    const sync = home.server.focusedSync()
    return projectDirectories().flatMap((directory) => {
      const [store] = sync.child(directory, { bootstrap: false })
      return store.session.filter((session) => !session.parentID && typeof session.time?.archived !== "number")
    })
  })
  const indexedSessions = createMemo(() =>
    retainHomeSessions(
      mergeHomeSessions(homeSessions().sessions(sessionLoad.data, sessionEventLoad.data), localSessions()),
      HOME_SESSION_LIMIT,
      Date.now(),
    ),
  )
  const allRecords = createMemo(() =>
    buildHomeSessionRecords({
      sessions: indexedSessions,
      projectDirectories,
      projects: home.project.list,
      projectByID,
    }),
  )
  const records = createMemo(() => allRecords().slice(0, HOME_SESSION_LIMIT))
  const [pins, setPins] = persisted(Persist.global("home.session.pins", ["home.session.pins.v1"]), createStore({ ids: [] as string[] }))
  const pinned = createMemo(() => new Set(pins.ids))
  const groups = createMemo(() => groupSessions(records(), pinned(), language))
  const prefetched = new Set<string>()

  createEffect(() => {
    const ctx = home.server.focusedContext()
    const conn = home.server.focused()
    if (!ctx || !conn) return
    records()
      .slice(0, 2)
      .forEach((record) => {
        const key = `${ServerConnection.key(conn)}\0${record.session.id}`
        if (prefetched.has(key)) return
        prefetched.add(key)
        createRoot((dispose) => {
          try {
            void ctx.sync.session
              .sync(record.session.id)
              .then(() =>
                Promise.all(
                  (ctx.sync.session.data.message[record.session.id] ?? []).flatMap((message) =>
                    (ctx.sync.session.data.part[message.id] ?? []).flatMap((part) => {
                      if (part.type !== "text" || !part.text) return []
                      return preloadMarkdown(part.text, part.id)
                    }),
                  ),
                ),
              )
              .catch(() => {})
              .finally(dispose)
          } catch {
            dispose()
          }
        })
      })
  })

  command.register("home.palette", () => [
    {
      id: "command.palette",
      title: language.t("command.palette"),
      hidden: true,
      onSelect: async () => {
        const conn = home.server.focused()
        if (!conn) return
        const ctx = home.server.focusedContext()
        if (!ctx) return
        const { DialogHomeCommandPaletteV2 } = await import("@/components/dialog-command-palette-v2")
        void dialog.show(() => (
          <DialogHomeCommandPaletteV2
            server={conn}
            onSelectSession={(entry) => {
              if (!entry.sessionID || !entry.directory || !entry.server) return
              const sessionID = entry.sessionID
              const server = entry.server
              const directory = entry.project?.worktree ?? entry.directory
              ctx.projects.open(directory)
              ctx.projects.touch(directory)
              void startTransition(() => {
                const tab = tabs.addSessionTab({ server, sessionId: sessionID })
                tabs.select(tab)
              })
            }}
          />
        ))
      },
    },
  ])

  return {
    copy: {
      language,
    },
    data: {
      records,
      groups,
      loading: () => sessionLoad.isLoading,
      searchRecords: allRecords,
    },
    session: {
      showProjectName: () => true,
      server: () => home.selection.value().server,
      canCreate: () => !!home.project.newSession(),
      create: home.project.openNewSession,
      open: (session: Session, options?: OpenSessionOptions) => {
        const project =
          home.project
            .list()
            .find(
              (item) =>
                samePath(item.worktree, session.directory) ||
                item.sandboxes?.some((sandbox) => samePath(sandbox, session.directory)),
            ) ?? projectForSession(session, home.project.list(), projectByID())
        const conn = home.server.focused()
        if (!conn) return
        const directory = project?.worktree ?? session.directory
        const ctx = home.server.focusedContext()
        if (!ctx) return
        ctx.projects.open(directory)
        if (options?.background) {
          tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })
          return
        }
        ctx.projects.touch(directory)
        void startTransition(() => {
          const tab = tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })
          tabs.select(tab)
        })
      },
      archive: async (session: Session) => {
        const conn = home.server.focused()
        const ctx = home.server.focusedContext()
        if (!conn || !ctx) return
        const [, setStore] = ctx.sync.child(session.directory)
        if ((await ctx.sdk.protocol) !== "v1") return
        await archiveHomeSession({
          server: ServerConnection.key(conn),
          session,
          archive: (sessionID) =>
            ctx.sdk.client.session.update({
              sessionID,
              directory: session.directory,
              time: { archived: Date.now() },
            }),
          remove: () => {
            setStore(
              produce((draft) => {
                const match = Binary.search(draft.session, session.id, (item) => item.id)
                if (match.found) draft.session.splice(match.index, 1)
              }),
            )
            homeSessions().remove(session.id)
          },
          onError: (cause) =>
            showToast({
              title: language.t("common.requestFailed"),
              description: errorMessage(cause, language.t("common.requestFailed")),
            }),
        })
      },
      pinned: (session: Session) => pinned().has(session.id),
      togglePin: (session: Session) => {
        if (pins.ids.includes(session.id)) {
          setPins("ids", pins.ids.filter((id) => id !== session.id))
          return
        }
        setPins("ids", [session.id, ...pins.ids])
      },
      remove: async (session: Session) => {
        const conn = home.server.focused()
        const ctx = home.server.focusedContext()
        if (!conn || !ctx) return
        const [, setStore] = ctx.sync.child(session.directory)
        try {
          await ctx.sdk.api.session.remove({ sessionID: session.id, directory: session.directory })
          setStore(
            produce((draft) => {
              const match = Binary.search(draft.session, session.id, (item) => item.id)
              if (match.found) draft.session.splice(match.index, 1)
            }),
          )
          homeSessions().remove(session.id)
          if (pins.ids.includes(session.id)) setPins("ids", pins.ids.filter((id) => id !== session.id))
          notifySessionTabsRemoved({
            server: ServerConnection.key(conn),
            directory: session.directory,
            sessionIDs: [session.id],
          })
        } catch (cause) {
          showToast({
            title: language.t("session.delete.failed.title"),
            description: errorMessage(cause, language.t("common.requestFailed")),
          })
        }
      },
    },
    tab: {
      isOpen: (record: HomeSessionRecord) =>
        sessionHasOpenTab(tabs.store, home.selection.value().server, record.session),
    },
  }
}

function directories(project: LocalProject) {
  return [project.worktree, ...(project.sandboxes ?? [])]
}

function mergeHomeSessions(indexed: Session[], local: Session[]) {
  const byID = new Map<string, Session>()
  for (const session of indexed) {
    if (session?.id) byID.set(session.id, session)
  }
  for (const session of local) {
    if (!session?.id) continue
    const current = byID.get(session.id)
    if (
      !current ||
      (session.time.updated ?? session.time.created) >= (current.time.updated ?? current.time.created)
    ) {
      byID.set(session.id, session)
    }
  }
  return [...byID.values()]
}

function buildHomeSessionRecords(input: {
  sessions: () => Session[]
  projectDirectories: () => string[]
  projects: () => LocalProject[]
  projectByID: () => Map<string, LocalProject>
}) {
  const sessions = input.sessions().filter((session) =>
    input.projectDirectories().some((directory) => samePath(session.directory, directory)),
  )
  return [...new Map(sessions.map((session) => [session.id, session] as const)).values()]
    .sort(compareSessionTime)
    .flatMap((session) => {
      const project =
        input
          .projects()
          .find(
            (item) =>
              samePath(item.worktree, session.directory) ||
              item.sandboxes?.some((sandbox) => samePath(sandbox, session.directory)),
          ) ?? projectForSession(session, input.projects(), input.projectByID())
      if (!project) return []
      return { session, project, projectName: displayName(project) }
    })
}

export function homeSessionSearchKey(record: HomeSessionRecord) {
  return `${pathKey(record.session.directory)}:${record.session.id}`
}

function groupSessions(
  records: HomeSessionRecord[],
  pinned: Set<string>,
  language: ReturnType<typeof useLanguage>,
): HomeSessionGroup[] {
  const pinnedSessions = records.filter((record) => pinned.has(record.session.id))
  const rest = records.filter((record) => !pinned.has(record.session.id))
  const byProject = new Map<string, HomeSessionRecord[]>()
  for (const record of rest) {
    const key = pathKey(record.project.worktree)
    const list = byProject.get(key)
    if (list) list.push(record)
    else byProject.set(key, [record])
  }
  const groups = [...byProject.entries()].map(([id, sessions]) => ({
    id,
    title: sessions[0]?.projectName ?? language.t("sidebar.project.recentSessions"),
    sessions,
  }))
  groups.sort((a, b) => {
    const left = a.sessions[0]?.session
    const right = b.sessions[0]?.session
    if (!left || !right) return a.title.localeCompare(b.title)
    return compareSessionTime(left, right)
  })
  if (pinnedSessions.length === 0) return groups
  return [{ id: "pinned", title: language.t("common.pin"), sessions: pinnedSessions }, ...groups]
}

export type HomeSessionsController = ReturnType<typeof createHomeSessionsController>

export function HomeSessionStatusController(props: {
  server: Accessor<ServerConnection.Key>
  record: HomeSessionRecord
  isOpenTab: (record: HomeSessionRecord) => boolean
  render: (state: { unread: Accessor<boolean>; loading: Accessor<boolean>; open: Accessor<boolean> }) => JSX.Element
}) {
  const avatar = useSessionTabAvatarState(
    props.server,
    () => props.record.session.directory,
    () => props.record.session.id,
  )
  return props.render({
    unread: avatar.unread,
    loading: avatar.loading,
    open: () => props.isOpenTab(props.record),
  })
}
