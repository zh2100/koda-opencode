import { createResource, onCleanup } from "solid-js"
import { createRelayRefreshLane, type RelayRefreshRuntime } from "./relay-refresh"
import { createStore, produce, reconcile } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import { relayErrorKey, vendorIdFromName, vendorURLValid } from "./relay-settings"
export { relayErrorKey, vendorIdFromName, vendorURLValid } from "./relay-settings"
import type {
  ServerRelayCandidatesOutput,
  ServerRelayGetOutput,
  ServerRelayManagedOutput,
  ServerRelaySyncOutput,
} from "../../../client/src/generated/types"

type Auth = ServerRelayGetOutput
type Candidate = ServerRelayCandidatesOutput[number]
type Managed = ServerRelayManagedOutput[number]
type Vendor = Auth["vendors"][number]
type ServerSDK = ReturnType<ReturnType<typeof useServerSDK>>
type RelayApi = ServerSDK["generatedApi"]["server.relay"]
type Draft = {
  name: string
  baseURL: string
  key: string
  baseline: { name: string; baseURL: string }
  conflicts: Array<"name" | "baseURL">
  entity: number
}

type Submission = {
  id: string
  raw: Draft
  patch: Partial<Draft["baseline"]>
  edits: ReadonlyMap<string, number>
  actionId: string
}

type Context = {
  api: RelayApi
  scope: string
  generation: number
  actionId: string
  entities: ReadonlyMap<string, number>
  vendorId?: string
  action?: string
  accept?: () => boolean
}

const defaultVendors: Vendor[] = []

export function createRelaySettingsState(
  serverSDK: () => Pick<ServerSDK, "scope" | "generatedApi">,
  refreshRuntime?: RelayRefreshRuntime,
) {
  const [store, setStore] = createStore({
    auth: undefined as Auth | undefined,
    candidates: [] as Candidate[],
    managed: [] as Managed[],
    error: undefined as ReturnType<typeof relayErrorKey> | undefined,
    testing: {} as Record<string, boolean>,
    fetching: {} as Record<string, boolean>,
    drafts: {} as Record<string, Draft>,
    addName: "",
    addURL: "",
    addKey: "",
    status: {} as Record<string, string>,
    open: undefined as string | undefined,
    adding: false,
    addUnconfirmed: false,
    addTargetChanged: false,
    notice: "idle" as "idle" | "pending" | "exhausted",
    catalogPending: false,
    refreshPending: false,
    visibilityPending: false,
  })

  const relay = () => serverSDK().generatedApi["server.relay"] as RelayApi
  const scope = () => serverSDK().scope
  const revision = () => store.auth?.revision ?? 0
  let generation = 0
  let alive = true
  let disposed = false
  let catalogVersion = 0
  let catalogTicket = 0
  let errorTicket = 0
  let errorOwner = 0
  let displayedError: { ticket: number; vendorId?: string; action?: string } | undefined
  const vendorEntities = new Map<string, number>()
  const vendorErrorOwner = new Map<string, number>()
  let requestSeq = 0
  let unownedCandidateWrite = 0
  let unownedManagedWrite = 0
  const vendorCatalog = new Map<string, number>()
  const vendorTicket = new Map<string, number>()
  const candidateWrite = new Map<string, number>()
  const managedWrite = new Map<string, number>()
  const busy = new Map<string, string>()
  const statusOwner = new Map<string, string>()
  const fieldEdits = new Map<string, number>()
  const fieldCommands = new Map<string, string>()
  const pendingSubmissions = new Map<string, Submission>()
  // Only an unresolved command retains its original sensitive DTO; a new edit replaces it.
  const unresolvedSaves = new Map<
    string,
    {
      payload: Parameters<RelayApi["vendor"]>[0]
      baseline: { entityId?: string; revision?: number; precise: boolean }
      raw: Draft
      edits: ReadonlyMap<string, number>
      patch: Partial<Draft["baseline"]>
      changed: boolean
    }
  >()
  const unresolvedClears = new Map<
    string,
    {
      payload: Parameters<RelayApi["key"]>[0]
      baseline: { entityId?: string; revision?: number; precise: boolean }
    }
  >()
  const keySubmissions = new Map<string, number>()
  const acceptedCatalog = new Map<string, { revision: number; seq: number }>()
  const pendingCatalog = new Map<string, { ticket: number; revision: number }>()
  const catalogOutcomes = new Map<string, number>()
  const syncedAuth = new Map<string, number>()
  let versionedCatalog = false
  let syncQueue: Promise<boolean | undefined> = Promise.resolve(undefined)
  let addingOwner: string | undefined
  let pendingCreate:
    | {
        context: Context
        raw: { name: string; baseURL: string; key: string }
        payload: Parameters<RelayApi["vendor"]>[0]
      }
    | undefined
  type RefreshOwner = {
    entityId: string | undefined
    lane: ReturnType<typeof createRelayRefreshLane>
    needed: number
    satisfied: number
    connection: number
    covered: number
    barrier: number
    visibility: number
    visibilityCovered: number
    running: Map<string, Promise<void>>
    failed: Set<string>
    visibilityRun?: Promise<void>
  }
  const refreshOwners = new Map<string, RefreshOwner>()
  const retireRefresh = () => {
    for (const owner of refreshOwners.values()) owner.lane.close()
    refreshOwners.clear()
  }
  let visibilityWrite: Promise<void> = Promise.resolve()
  let visibilityGeneration = generation

  const current = (actionId = crypto.randomUUID()): Context => ({
    api: relay(),
    scope: scope(),
    generation,
    actionId,
    entities: new Map(vendorEntities),
  })

  const active = (context: Context) =>
    alive && !disposed && context.generation === generation && context.scope === scope() && (context.accept?.() ?? true)

  const entityCurrent = (context: Context, id: string) =>
    active(context) && (context.entities.get(id) ?? 0) === (vendorEntities.get(id) ?? 0)

  const resetForScope = () => {
    generation += 1
    retireRefresh()
    catalogVersion += 1
    vendorCatalog.clear()
    vendorTicket.clear()
    candidateWrite.clear()
    managedWrite.clear()
    unownedCandidateWrite = 0
    unownedManagedWrite = 0
    errorTicket += 1
    errorOwner = errorTicket
    vendorErrorOwner.clear()
    vendorEntities.clear()
    displayedError = undefined
    fieldEdits.clear()
    fieldCommands.clear()
    pendingSubmissions.clear()
    unresolvedSaves.clear()
    unresolvedClears.clear()
    keySubmissions.clear()
    acceptedCatalog.clear()
    pendingCatalog.clear()
    catalogOutcomes.clear()
    syncedAuth.clear()
    versionedCatalog = false
    syncQueue = Promise.resolve(undefined)
    pendingCreate = undefined
    addingOwner = undefined
    setStore({
      adding: false,
      addUnconfirmed: false,
      addTargetChanged: false,
      notice: "idle",
      catalogPending: false,
      refreshPending: false,
      visibilityPending: false,
    })
    busy.clear()
    statusOwner.clear()
    visibilityWrite = Promise.resolve()
    visibilityGeneration = generation
    setStore("drafts", reconcile({}))
    setStore("status", reconcile({}))
    setStore("candidates", [])
    setStore("managed", [])
    setStore("error", undefined)
    setStore("testing", reconcile({}))
    setStore("fetching", reconcile({}))
    setStore("addName", "")
    setStore("addURL", "")
    setStore("addKey", "")
    setStore("auth", undefined)
    setStore("open", undefined)
  }

  const invalidate = (ids: readonly string[], context: Context) => {
    if (!active(context)) return
    ids.forEach((id) => {
      const next = vendorGeneration(id) + 1
      vendorCatalog.set(id, next)
      if (statusOwner.get(id) !== context.actionId) statusOwner.delete(id)
      setStore("status", id, "")
    })
    setStore("candidates", (items) => items.filter((item) => !item.vendorId || !ids.includes(item.vendorId)))
    setStore("managed", (items) => items.filter((item) => !ids.includes(item.vendorId)))
  }

  const supported = (capability: string) => store.auth?.capabilities?.includes(capability) ?? false
  const protectedVendor = (vendorId: string) =>
    supported("vendor-entity-v1") && !!store.auth?.vendors.find((vendor) => vendor.id === vendorId)?.entityId

  const applyAuth = (auth: Auth, context: Context, submitted?: Submission) => {
    if (!active(context)) return false
    const accepted = auth.revision >= (store.auth?.revision ?? 0)
    if (accepted) {
      ;(store.auth?.vendors ?? defaultVendors).forEach((previous) => {
        const incoming = auth.vendors.find((item) => item.id === previous.id)
        if (incoming && !store.auth) return
        if (incoming && incoming.builtin === previous.builtin && incoming.entityId === previous.entityId) return
        vendorEntities.set(previous.id, (vendorEntities.get(previous.id) ?? 0) + 1)
        invalidate([previous.id], context)
        setStore(
          "drafts",
          produce((drafts) => {
            delete drafts[previous.id]
          }),
        )
        unresolvedSaves.delete(previous.id)
        unresolvedClears.delete(previous.id)
        vendorErrorOwner.delete(previous.id)
        statusOwner.delete(previous.id)
        for (const kind of ["testing", "fetching"] as const) {
          busy.delete(`${kind}:${previous.id}`)
          setStore(
            kind,
            produce((items) => {
              delete items[previous.id]
            }),
          )
        }
        if (displayedError?.vendorId === previous.id) {
          displayedError = undefined
          setStore("error", undefined)
        }
      })
      auth.vendors.forEach((vendor) => {
        const cached = store.drafts[vendor.id]
        if (!cached) return
        const next = { ...cached, baseline: { ...cached.baseline }, conflicts: [...cached.conflicts] }
        for (const field of ["name", "baseURL"] as const) {
          const incoming = vendor[field] ?? ""
          const pending = pendingSubmissions.get(fieldCommands.get(`${vendor.id}:${field}`) ?? "")
          if (pending && (fieldEdits.get(`${vendor.id}:${field}`) ?? 0) !== (pending.edits.get(field) ?? 0)) {
            if (next[field] !== incoming && incoming !== next.baseline[field] && !next.conflicts.includes(field))
              next.conflicts.push(field)
            continue
          }
          if (next[field] === next.baseline[field]) next[field] = incoming
          else if (next[field] !== incoming) {
            if (incoming !== next.baseline[field] && !next.conflicts.includes(field)) next.conflicts.push(field)
            continue
          }
          next.baseline[field] = incoming
          next.conflicts = next.conflicts.filter((item) => item !== field)
        }
        setStore("drafts", vendor.id, next)
      })
      setStore("auth", auth)
      observeRefreshOwners(context)
    }
    if (submitted && entityCurrent(context, submitted.id)) {
      const acknowledged = auth.vendors.find((vendor) => vendor.id === submitted.id)
      const authoritative = store.auth?.vendors.find((vendor) => vendor.id === submitted.id)
      const cached = store.drafts[submitted.id]
      if (
        acknowledged &&
        authoritative &&
        cached &&
        acknowledged.entityId === authoritative.entityId &&
        cached.entity === submitted.raw.entity
      ) {
        const next = { ...cached, baseline: { ...cached.baseline }, conflicts: [...cached.conflicts] }
        for (const field of ["name", "baseURL"] as const) {
          if (
            submitted.patch[field] === undefined ||
            fieldCommands.get(`${submitted.id}:${field}`) !== submitted.actionId
          )
            continue
          const currentValue = authoritative[field] ?? ""
          const savedValue = acknowledged[field] ?? ""
          const edited = (fieldEdits.get(`${submitted.id}:${field}`) ?? 0) !== (submitted.edits.get(field) ?? 0)
          if (!edited && next[field] === submitted.raw[field]) next[field] = currentValue
          next.baseline[field] = currentValue
          const conflict =
            edited && next[field] !== currentValue && next[field] !== savedValue && currentValue !== savedValue
          next.conflicts = next.conflicts.filter((item) => item !== field)
          if (conflict) next.conflicts.push(field)
        }
        setStore("drafts", submitted.id, next)
      }
    }
    return accepted
  }

  const issueTicket = () => {
    errorTicket += 1
    errorOwner = errorTicket
    return errorTicket
  }

  const ownsError = (context: Context, ticket: number, vendorId?: string) => {
    if (!active(context) || (vendorId && !entityCurrent(context, vendorId))) return false
    if (vendorId) return vendorErrorOwner.get(vendorId) === ticket
    return ticket === errorOwner
  }

  const clearError = (context: Context, ticket: number) => {
    if (!ownsError(context, ticket)) return
    displayedError = undefined
    setStore("error", undefined)
  }

  const clearActionError = (context: Context, ticket: number) => {
    if (!ownsError(context, ticket, context.vendorId)) return
    if (
      displayedError &&
      (displayedError.ticket > ticket ||
        displayedError.vendorId !== context.vendorId ||
        displayedError.action !== context.action)
    )
      return
    displayedError = undefined
    setStore("error", undefined)
  }

  const fail = (error: unknown, context: Context, ticket: number, vendorId?: string): never => {
    const target = vendorId ?? context.vendorId
    if (ownsError(context, ticket, target)) {
      displayedError = { ticket, vendorId: target, action: context.action }
      setStore("error", relayErrorKey(error))
    }
    throw error
  }

  const beginAction = (context: Context, vendorId?: string, action?: string) => {
    const ticket = issueTicket()
    context.vendorId = vendorId
    context.action = action
    if (vendorId) vendorErrorOwner.set(vendorId, ticket)
    return ticket
  }

  const beginBusy = (kind: "testing" | "fetching", vendorId: string, context: Context) => {
    if (!active(context)) return
    busy.set(`${kind}:${vendorId}`, context.actionId)
    statusOwner.set(vendorId, context.actionId)
    setStore(kind, vendorId, true)
  }

  const endBusy = (kind: "testing" | "fetching", vendorId: string, context: Context) => {
    const key = `${kind}:${vendorId}`
    if (busy.get(key) !== context.actionId) return
    busy.delete(key)
    if (!active(context)) return
    setStore(
      kind,
      produce((items) => {
        delete items[vendorId]
      }),
    )
  }

  const vendorGeneration = (vendorId: string) => vendorCatalog.get(vendorId) ?? 0

  const vendorIdentity = (vendorId: string) => {
    const vendor = store.auth?.vendors.find((item) => item.id === vendorId)
    return {
      present: !!vendor,
      builtin: vendor?.builtin ?? false,
      entityId: vendor?.entityId,
      revision: vendor?.revision,
      baseURL: vendor?.baseURL ?? "",
      generation: vendorGeneration(vendorId),
    }
  }

  const sameIdentity = (vendorId: string, captured: ReturnType<typeof vendorIdentity>) => {
    const currentIdentity = vendorIdentity(vendorId)
    return (
      currentIdentity.present === captured.present &&
      currentIdentity.builtin === captured.builtin &&
      currentIdentity.entityId === captured.entityId &&
      currentIdentity.revision === captured.revision &&
      currentIdentity.baseURL === captured.baseURL &&
      currentIdentity.generation === captured.generation
    )
  }

  const vendorStamp = () => new Map(vendorCatalog)
  const ticketStamp = () => new Map(vendorTicket)

  const unchanged = (
    id: string | undefined,
    versions: ReadonlyMap<string, number>,
    tickets: ReadonlyMap<string, number>,
  ) => {
    if (!id) return true
    return vendorGeneration(id) === (versions.get(id) ?? 0) && (vendorTicket.get(id) ?? 0) === (tickets.get(id) ?? 0)
  }

  const stageWrite = (stage: "candidates" | "managed") => (stage === "candidates" ? candidateWrite : managedWrite)

  const writtenAfter = (stage: "candidates" | "managed", vendorId: string, seq: number) =>
    (stageWrite(stage).get(vendorId) ?? 0) > seq

  const takeSlice = (
    stage: "candidates" | "managed",
    vendorId: string,
    seq: number,
    versions: ReadonlyMap<string, number>,
    tickets: ReadonlyMap<string, number>,
  ) => {
    const writes = stageWrite(stage)
    if (writtenAfter(stage, vendorId, seq)) return false
    if (!unchanged(vendorId, versions, tickets) && (writes.get(vendorId) ?? 0) !== seq) return false
    writes.set(vendorId, seq)
    return true
  }

  const mergeOwned = <T extends { vendorId?: string }>(
    stage: "candidates" | "managed",
    currentItems: readonly T[],
    incoming: readonly T[],
    seq: number,
    versions: ReadonlyMap<string, number>,
    tickets: ReadonlyMap<string, number>,
    acceptUnowned: boolean,
  ) => {
    const known = new Set<string>([...versions.keys(), ...stageWrite(stage).keys()])
    currentItems.forEach((item) => {
      if (item.vendorId) known.add(item.vendorId)
    })
    incoming.forEach((item) => {
      if (item.vendorId) known.add(item.vendorId)
    })
    const taken = new Set<string>()
    known.forEach((vendorId) => {
      if (takeSlice(stage, vendorId, seq, versions, tickets)) taken.add(vendorId)
    })
    const accepted = incoming.filter((item) => (item.vendorId ? taken.has(item.vendorId) : acceptUnowned))
    const kept = currentItems.filter((item) => {
      if (!item.vendorId) return !acceptUnowned
      return !taken.has(item.vendorId)
    })
    return [...kept, ...accepted]
  }

  const replaceVendor = <T extends { vendorId?: string }>(
    currentItems: readonly T[],
    incoming: readonly T[],
    vendorId: string,
  ) => [
    ...currentItems.filter((item) => item.vendorId !== vendorId),
    ...incoming.filter((item) => item.vendorId === vendorId),
  ]

  const refreshOwner = (id: string) => {
    const vendor = store.auth?.vendors.find((item) => item.id === id)
    if (!vendor) return
    const previous = refreshOwners.get(id)
    if (previous && previous.entityId === vendor.entityId) return previous
    previous?.lane.close()
    const owner: RefreshOwner = {
      entityId: vendor.entityId,
      lane: createRelayRefreshLane(refreshRuntime),
      needed: 0,
      satisfied: 0,
      connection: 0,
      covered: 0,
      barrier: 0,
      visibility: 0,
      visibilityCovered: 0,
      running: new Map(),
      failed: new Set(),
    }
    refreshOwners.set(id, owner)
    return owner
  }
  const refreshPending = () => {
    if (disposed) return
    setStore(
      "refreshPending",
      [...refreshOwners.values()].some((item) => item.needed > item.satisfied),
    )
    setStore(
      "visibilityPending",
      [...refreshOwners.values()].some((item) => item.visibility > item.visibilityCovered),
    )
  }
  const observeRefreshOwners = (context: Context) => {
    if (!active(context)) return
    for (const [id, owner] of refreshOwners) {
      const vendor = store.auth?.vendors.find((item) => item.id === id)
      if (!vendor || vendor.entityId !== owner.entityId) {
        owner.lane.close()
        refreshOwners.delete(id)
        continue
      }
      if (vendor.hasKey) continue
      owner.barrier = Math.max(owner.barrier, vendor.revision ?? 0)
      owner.satisfied = owner.needed
      owner.visibilityCovered = owner.visibility
      owner.lane.cancel()
    }
    refreshPending()
  }
  const sameEntity = (id: string, identity: ReturnType<typeof vendorIdentity>) => {
    const latest = vendorIdentity(id)
    return (
      latest.present && identity.present && latest.entityId === identity.entityId && latest.builtin === identity.builtin
    )
  }
  const boundedContext = (context: Context, owner: RefreshOwner, deadline: number): Context => {
    const request = <T>(job: (signal: AbortSignal) => Promise<T>) =>
      owner.lane.request((signal) => {
        if (!active(bounded)) return Promise.reject(new Error("REQUEST_CONFLICT"))
        return job(signal)
      }, deadline)
    const bounded: Context = {
      ...context,
      api: {
        ...context.api,
        get: () => request((signal) => context.api.get(undefined, { signal })),
        refresh: (input) => request((signal) => context.api.refresh(input, { signal })),
        sync: (input) => request((signal) => context.api.sync(input, { signal })),
        candidates: (input) => request((signal) => context.api.candidates(input, { signal })),
        managed: () => request((signal) => context.api.managed(undefined, { signal })),
      },
    }
    return bounded
  }
  const recordConnection = (
    context: Context,
    id: string,
    baseline: { entityId?: string; revision?: number; precise: boolean },
    ack: Auth,
    kind: "connection" | "clear",
  ) => {
    if (!entityCurrent(context, id)) return
    const owner = refreshOwner(id)
    if (!owner || owner.entityId !== baseline.entityId) return
    const commit =
      baseline.precise && ack.capabilities?.includes("vendor-commit-baseline-v1") && baseline.revision !== undefined
        ? baseline.revision + 1
        : undefined
    if (kind === "clear") {
      // A late clear ACK cannot erase a later, independently confirmed connection.
      if (commit !== undefined) owner.barrier = Math.max(owner.barrier, commit)
      if (
        (commit !== undefined && commit < owner.connection) ||
        store.auth?.vendors.find((item) => item.id === id)?.hasKey
      )
        return
      owner.satisfied = owner.needed
      refreshPending()
      return
    }
    if (!store.auth?.vendors.find((item) => item.id === id)?.hasKey) return
    if (commit !== undefined) {
      if (commit <= Math.max(owner.barrier, owner.connection, owner.covered)) return
      owner.connection = commit
    }
    owner.needed++
    refreshPending()
  }
  const refreshTarget = (id: string, owner: RefreshOwner) => {
    const identity = vendorIdentity(id)
    return `${identity.revision}:${identity.generation}:${owner.needed}`
  }
  const continueRefresh = (
    context: Context,
    id: string,
    ticket: number,
    retry = false,
    deadline?: number,
  ): Promise<void> => {
    const owner = refreshOwner(id)
    if (
      !owner ||
      !entityCurrent(context, id) ||
      owner.needed <= owner.satisfied ||
      pendingCatalog.has(id) ||
      !store.auth?.vendors.find((item) => item.id === id)?.hasKey
    )
      return Promise.resolve()
    const target = refreshTarget(id, owner)
    const existing = owner.running.get(target)
    if (existing) return existing
    if (retry) owner.failed.delete(target)
    if (owner.failed.has(target)) return Promise.resolve()
    const bounded = boundedContext(context, owner, deadline ?? owner.lane.deadline())
    bounded.accept = () => refreshOwners.get(id) === owner && refreshTarget(id, owner) === target
    const needed = owner.needed
    const run = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!entityCurrent(context, id) || refreshOwners.get(id) !== owner || refreshTarget(id, owner) !== target)
          return
        try {
          const accepted = await loadCatalog(bounded, id, ticket)
          if (
            accepted &&
            entityCurrent(context, id) &&
            refreshOwners.get(id) === owner &&
            refreshTarget(id, owner) === target
          ) {
            owner.satisfied = Math.max(owner.satisfied, needed)
            owner.covered = Math.max(owner.covered, owner.connection)
            refreshPending()
          }
          return
        } catch (error) {
          if (!entityCurrent(context, id) || refreshOwners.get(id) !== owner || refreshTarget(id, owner) !== target)
            return
          const message = error && typeof error === "object" && "message" in error ? error.message : undefined
          const conflict = message === "REQUEST_CONFLICT" || message === "REVISION_CONFLICT"
          if (!conflict || attempt !== 0) {
            owner.failed.add(target)
            return fail(error, context, ticket, id)
          }
          const auth = await bounded.api.get().catch((error) => fail(error, context, ticket, id))
          applyAuth(auth, context)
          if (refreshTarget(id, owner) !== target) return
        }
      }
    }
    const running = run().finally(() => {
      if (owner.running.get(target) === running) owner.running.delete(target)
      refreshPending()
      if (entityCurrent(context, id) && refreshOwners.get(id) === owner && refreshTarget(id, owner) !== target)
        void continueRefresh(context, id, vendorErrorOwner.get(id) ?? ticket).catch(() => undefined)
    })
    owner.running.set(target, running)
    return running
  }
  const continueVisibility = (context: Context, id: string, ticket: number, deadline?: number): Promise<void> => {
    const owner = refreshOwner(id)
    if (!owner || !entityCurrent(context, id) || owner.visibility <= owner.visibilityCovered) return Promise.resolve()
    if (owner.visibilityRun) return owner.visibilityRun
    const bounded = boundedContext(context, owner, deadline ?? owner.lane.deadline())
    let attempted = owner.visibility
    const run = async () => {
      while (
        entityCurrent(context, id) &&
        refreshOwners.get(id) === owner &&
        owner.visibility > owner.visibilityCovered
      ) {
        const fence = owner.visibility
        attempted = fence
        const identity = vendorIdentity(id)
        const accepted = supported("catalog-sync-v1")
          ? await syncCatalog(bounded, ticket, false, id)
          : await readVisibility(bounded, id, ticket)
        if (!accepted) {
          if (owner.visibility > fence || vendorIdentity(id).revision !== identity.revision) continue
          return
        }
        owner.visibilityCovered = Math.max(owner.visibilityCovered, fence)
        refreshPending()
      }
    }
    const pending = run()
      .catch((error) => {
        if (
          !entityCurrent(context, id) ||
          refreshOwners.get(id) !== owner ||
          owner.visibility <= owner.visibilityCovered
        )
          return
        throw error
      })
      .finally(() => {
        if (owner.visibilityRun === pending) owner.visibilityRun = undefined
        refreshPending()
        // An ACK can arrive between the last loop check and this finalizer.
        if (entityCurrent(context, id) && refreshOwners.get(id) === owner && owner.visibility > attempted)
          void continueVisibility(context, id, vendorErrorOwner.get(id) ?? ticket).catch(() => undefined)
      })
    owner.visibilityRun = pending
    return pending
  }
  const readVisibility = async (context: Context, id: string, ticket: number) => {
    const identity = vendorIdentity(id)
    const baseline = managedWrite.get(id) ?? 0
    const incoming = await context.api.managed().catch((error) => fail(error, context, ticket, id))
    if (
      !entityCurrent(context, id) ||
      !sameEntity(id, identity) ||
      vendorGeneration(id) !== identity.generation ||
      (managedWrite.get(id) ?? 0) !== baseline
    )
      return false
    requestSeq++
    managedWrite.set(id, requestSeq)
    setStore("managed", replaceVendor(store.managed, incoming, id))
    return true
  }

  const syncCatalog = async (context: Context, owner: number, retryNotice = false, errorVendor?: string) => {
    const execute = async () => {
      if (!active(context)) return
      requestSeq += 1
      const seq = requestSeq
      const versions = vendorStamp()
      const tickets = ticketStamp()
      const visibilityFences = new Map([...refreshOwners].map(([id, owner]) => [id, owner.visibility]))
      const data: ServerRelaySyncOutput = await context.api
        .sync({ retryNotice })
        .catch((error) => fail(error, context, owner, errorVendor))
      if (!active(context)) return
      if (data.catalogRevision === null && versionedCatalog)
        return fail(new Error("REQUEST_CONFLICT"), context, owner, errorVendor)
      const revision = data.catalogRevision
      if (revision !== null) versionedCatalog = true
      // Record local changes before applying this response's own identity transition.
      const eligible = new Set(
        [
          ...new Set([
            ...vendorCatalog.keys(),
            ...vendorTicket.keys(),
            ...data.auth.vendors.map((vendor) => vendor.id),
            ...(store.auth?.vendors.map((vendor) => vendor.id) ?? []),
          ]),
        ].filter((id) => unchanged(id, versions, tickets)),
      )
      applyAuth(data.auth, context)
      if (!active(context)) return false
      const accepted = new Map<"candidates" | "managed", Set<string>>()
      for (const stage of ["candidates", "managed"] as const) {
        const incoming = data[stage]
        const present = store[stage]
        const ids = new Set<string>([
          ...data.auth.vendors.map((vendor) => vendor.id),
          ...(store.auth?.vendors.map((vendor) => vendor.id) ?? []),
          ...present.flatMap((item) => (item.vendorId ? [item.vendorId] : [])),
          ...incoming.flatMap((item) => (item.vendorId ? [item.vendorId] : [])),
          ...stageWrite(stage).keys(),
          ...pendingCatalog.keys(),
        ])
        const taken = new Set<string>()
        for (const id of ids) {
          const remote = data.auth.vendors.find((vendor) => vendor.id === id)
          const currentVendor = store.auth?.vendors.find((vendor) => vendor.id === id)
          if (remote?.entityId !== currentVendor?.entityId || remote?.revision !== currentVendor?.revision) continue
          if (!eligible.has(id) && !unchanged(id, versions, tickets)) continue
          const key = `${stage}:${id}`
          const previous = acceptedCatalog.get(key)
          if (
            revision !== null &&
            previous &&
            (revision < previous.revision || (revision === previous.revision && seq < previous.seq))
          )
            continue
          if (revision === null && writtenAfter(stage, id, seq)) continue
          taken.add(id)
          stageWrite(stage).set(id, Math.max(seq, stageWrite(stage).get(id) ?? 0))
          if (revision !== null) acceptedCatalog.set(key, { revision, seq })
        }
        const unownedKey = `${stage}:`
        const previous = acceptedCatalog.get(unownedKey)
        const takeUnowned =
          revision === null
            ? !previous
            : !previous || revision > previous.revision || (revision === previous.revision && seq >= previous.seq)
        if (takeUnowned && revision !== null) acceptedCatalog.set(unownedKey, { revision, seq })
        const merged = [
          ...present.filter((item) => (item.vendorId ? !taken.has(item.vendorId) : !takeUnowned)),
          ...incoming.filter((item) => (item.vendorId ? taken.has(item.vendorId) : takeUnowned)),
        ]
        if (stage === "candidates") setStore("candidates", merged as Candidate[])
        else setStore("managed", merged as Managed[])
        accepted.set(stage, taken)
      }
      for (const id of accepted.get("candidates") ?? []) {
        if (!accepted.get("managed")?.has(id)) continue
        const owner = refreshOwners.get(id)
        if (owner) owner.visibilityCovered = Math.max(owner.visibilityCovered, visibilityFences.get(id) ?? 0)
        syncedAuth.set(id, Math.max(syncedAuth.get(id) ?? 0, data.auth.revision))
        const pending = pendingCatalog.get(id)
        if (pending && data.auth.revision >= pending.revision) pendingCatalog.delete(id)
      }
      setStore("catalogPending", pendingCatalog.size > 0)
      if (ownsError(context, owner, errorVendor)) setStore("notice", data.notice.status)
      refreshPending()
      return errorVendor
        ? accepted.get("candidates")?.has(errorVendor) && accepted.get("managed")?.has(errorVendor)
        : true
    }
    if (versionedCatalog) return execute()
    const queued = syncQueue.catch(() => undefined).then(execute)
    syncQueue = queued
    return queued
  }

  const loadCatalog = async (context: Context, vendorId: string | undefined, owner: number) => {
    if (supported("catalog-sync-v1")) {
      if (vendorId) {
        if (!entityCurrent(context, vendorId) || !protectedVendor(vendorId)) return
        const identity = vendorIdentity(vendorId)
        await context.api
          .refresh({ vendorId, expectedEntityId: identity.entityId, expectedVendorRevision: identity.revision })
          .catch((error) => fail(error, context, owner, vendorId))
        if (!entityCurrent(context, vendorId) || !sameIdentity(vendorId, identity)) return false
      }
      return syncCatalog(context, owner, false, vendorId)
    }
    const version = catalogVersion
    const vendorVersion = vendorId ? vendorGeneration(vendorId) : 0
    const ticket = (vendorId ? (vendorTicket.get(vendorId) ?? 0) : catalogTicket) + 1
    if (vendorId) vendorTicket.set(vendorId, ticket)
    if (!vendorId) catalogTicket = ticket
    requestSeq += 1
    const seq = requestSeq
    const versions = vendorStamp()
    const tickets = ticketStamp()
    const unownedCandidatesAt = unownedCandidateWrite
    const candidateBaseline = vendorId ? (candidateWrite.get(vendorId) ?? 0) : 0
    const errorVendor = vendorId !== undefined && vendorErrorOwner.get(vendorId) === owner ? vendorId : undefined
    const candidates = await (
      vendorId
        ? context.api.refresh({ vendorId }).then(() => context.api.candidates({ vendorId }))
        : context.api.candidates()
    ).catch((error) => fail(error, context, owner, errorVendor))
    if (!candidates || !active(context) || (vendorId && !entityCurrent(context, vendorId))) return
    if (
      vendorId &&
      (version !== catalogVersion ||
        vendorGeneration(vendorId) !== vendorVersion ||
        writtenAfter("candidates", vendorId, seq))
    )
      return
    if (!vendorId && version !== catalogVersion) return
    if (vendorId) {
      if ((candidateWrite.get(vendorId) ?? 0) !== candidateBaseline) return
      if ((vendorTicket.get(vendorId) ?? 0) !== ticket && vendorErrorOwner.get(vendorId) !== owner) return
      requestSeq += 1
      const writeSeq = requestSeq
      candidateWrite.set(vendorId, writeSeq)
      setStore("candidates", replaceVendor(store.candidates, candidates, vendorId))
    }
    if (!vendorId) {
      const acceptUnowned = unownedCandidateWrite === unownedCandidatesAt && catalogTicket === ticket
      if (acceptUnowned) unownedCandidateWrite = seq
      setStore(
        "candidates",
        mergeOwned("candidates", store.candidates, candidates, seq, versions, tickets, acceptUnowned),
      )
    }
    const managedBaseline = vendorId ? (managedWrite.get(vendorId) ?? 0) : 0
    const unownedManagedAt = unownedManagedWrite
    const managed = await context.api.managed().catch((error) => fail(error, context, owner, errorVendor))
    if (!managed || !active(context) || (vendorId && !entityCurrent(context, vendorId))) return
    if (
      vendorId &&
      (version !== catalogVersion ||
        vendorGeneration(vendorId) !== vendorVersion ||
        (managedWrite.get(vendorId) ?? 0) !== managedBaseline)
    )
      return
    if (vendorId && (vendorTicket.get(vendorId) ?? 0) !== ticket && vendorErrorOwner.get(vendorId) !== owner) return
    if (!vendorId && version !== catalogVersion) return
    if (vendorId) {
      requestSeq += 1
      const writeSeq = requestSeq
      managedWrite.set(vendorId, writeSeq)
      setStore(
        "managed",
        replaceVendor(
          store.managed,
          managed.filter((item) => item.vendorId === vendorId),
          vendorId,
        ),
      )
    }
    if (!vendorId) {
      const acceptUnowned = unownedManagedWrite === unownedManagedAt && catalogTicket === ticket
      if (acceptUnowned) unownedManagedWrite = seq
      setStore("managed", mergeOwned("managed", store.managed, managed, seq, versions, tickets, acceptUnowned))
    }
    return true
  }

  const load = async (retryNotice = false, captured?: Context) => {
    const context = captured ?? current()
    const ticket = issueTicket()
    try {
      if (supported("catalog-sync-v1")) {
        const accepted = await syncCatalog(context, ticket, retryNotice)
        if (accepted) clearError(context, ticket)
        return accepted
      }
      const auth = await context.api.get()
      if (!active(context) || ticket !== errorOwner) return
      const applied = applyAuth(auth, context)
      if (ticket !== errorOwner) return
      if (!applied) return
      const accepted = await loadCatalog(context, undefined, ticket)
      if (accepted) clearError(context, ticket)
      return accepted
    } catch (error) {
      if (ownsError(context, ticket)) {
        displayedError = { ticket }
        setStore("error", relayErrorKey(error))
      }
      return false
    }
  }

  let seenScope = scope()
  let initial: ReturnType<typeof load> | undefined = load()
  const [resource] = createResource(
    () => {
      const next = scope()
      if (disposed) return
      if (next !== seenScope) {
        seenScope = next
        resetForScope()
      }
      return `${next}:${generation}`
    },
    () => {
      const pending = initial
      initial = undefined
      return pending ?? load()
    },
  )

  const call = async <T>(context: Context, ticket: number, request: (api: RelayApi) => Promise<T>) => {
    const result = await request(context.api).catch((error) => fail(error, context, ticket))
    if (!active(context) || (context.vendorId && !entityCurrent(context, context.vendorId))) return
    return result
  }

  const clearSubmitted = (vendorId: string, submitted: Draft, context: Context) => {
    if (!entityCurrent(context, vendorId)) return
    const currentDraft = store.drafts[vendorId]
    if (!currentDraft) return
    if (currentDraft.entity !== submitted.entity) return
    if (currentDraft.key !== submitted.key) return
    if ((fieldEdits.get(`${vendorId}:key`) ?? 0) !== (keySubmissions.get(context.actionId) ?? 0)) return
    setStore("drafts", vendorId, "key", "")
  }

  const requireProtection = (context: Context, ticket: number, vendorId?: string, create = false) => {
    if (
      !supported("independent-vendors-v1") ||
      !supported("vendor-entity-v1") ||
      (vendorId && !protectedVendor(vendorId)) ||
      (create && !supported("vendor-create-receipt-v1"))
    )
      fail(new Error("RELAY_UNSUPPORTED"), context, ticket, vendorId)
  }

  const commandId = (context: Context, command: string) => `${context.actionId}:${command}`

  const recordCatalogOutcome = (auth: Auth, context: Context, ticket: number, vendorId: string) => {
    if (!auth.catalogSync || !entityCurrent(context, vendorId)) return
    if (ticket < (catalogOutcomes.get(vendorId) ?? 0)) return
    catalogOutcomes.set(vendorId, ticket)
    if (auth.catalogSync.status !== "pending" || (syncedAuth.get(vendorId) ?? -1) >= auth.revision) return
    pendingCatalog.set(vendorId, { ticket, revision: auth.revision })
    setStore("catalogPending", true)
  }

  const saveVendor = async (vendor: Vendor, refresh = true, parent?: Context, parentTicket?: number) => {
    const context = parent ?? current()
    const ticket = parentTicket ?? beginAction(context, vendor.id, "vendor")
    const latest = store.auth?.vendors.find((item) => item.id === vendor.id)
    if (store.auth && !latest) return
    if (latest && vendor.entityId && vendor.entityId !== latest.entityId)
      fail(new Error("REQUEST_CONFLICT"), context, ticket, vendor.id)
    const value = draft(latest ?? vendor)
    const submitted = { ...value, baseline: { ...value.baseline }, conflicts: [...value.conflicts] }
    const edits = new Map(
      ["name", "baseURL", "key"].map((field) => [field, fieldEdits.get(`${vendor.id}:${field}`) ?? 0]),
    )
    const previous = unresolvedSaves.get(vendor.id)
    const retry =
      previous &&
      previous.baseline.entityId === latest?.entityId &&
      (["name", "baseURL", "key"] as const).every(
        (field) => previous.raw[field] === submitted[field] && previous.edits.get(field) === edits.get(field),
      )
        ? previous
        : undefined
    if (submitted.conflicts.length && !retry) fail(new Error("REVISION_CONFLICT"), context, ticket, vendor.id)
    const baseURL = submitted.baseURL.trim().replace(/\/+$/, "")
    const patch = retry?.patch ?? {
      ...(submitted.name !== submitted.baseline.name
        ? { name: submitted.name.trim() || latest?.name || vendor.name }
        : {}),
      ...(!vendor.builtin && submitted.baseURL !== submitted.baseline.baseURL ? { baseURL } : {}),
    }
    const changed = !!submitted.key.trim() || patch.baseURL !== undefined
    if (!vendor.builtin && (baseURL || vendor.baseURL) && !vendorURLValid(baseURL))
      fail(
        new Error(baseURL ? "provider.custom.error.baseURL.format" : "provider.custom.error.baseURL.required"),
        context,
        ticket,
      )
    if (!store.auth) {
      const primed = await context.api.get().catch((error) => fail(error, context, ticket))
      if (!active(context)) return
      applyAuth(primed, context)
    }
    if (!entityCurrent(context, vendor.id) || !store.auth?.vendors.some((item) => item.id === vendor.id)) return
    requireProtection(context, ticket, vendor.id)
    for (const field of Object.keys(patch)) fieldCommands.set(`${vendor.id}:${field}`, context.actionId)
    keySubmissions.set(context.actionId, edits.get("key") ?? 0)
    pendingSubmissions.set(context.actionId, {
      id: vendor.id,
      raw: submitted,
      patch: retry?.patch ?? patch,
      edits,
      actionId: context.actionId,
    })
    const baselineVendor = store.auth!.vendors.find((item) => item.id === vendor.id)!
    const baseline = retry?.baseline ?? {
      entityId: baselineVendor.entityId,
      revision: baselineVendor.revision,
      precise: supported("vendor-commit-baseline-v1"),
    }
    const payload =
      retry?.payload ??
      Object.freeze({
        vendorId: vendor.id,
        expectedEntityId: baselineVendor.entityId,
        ...patch,
        ...(submitted.key.trim() ? { key: submitted.key.trim() } : {}),
        revision: revision(),
        operationId: commandId(context, "vendor"),
      })
    const command = retry ?? { payload, baseline, raw: submitted, edits, patch, changed }
    unresolvedSaves.set(vendor.id, command)
    try {
      const auth = await call(context, ticket, (api) => api.vendor(payload))
      if (!auth) return auth
      if (unresolvedSaves.get(vendor.id) === command) unresolvedSaves.delete(vendor.id)
      recordCatalogOutcome(auth, context, ticket, vendor.id)
      const applied = applyAuth(auth, context, {
        id: vendor.id,
        raw: submitted,
        patch,
        edits,
        actionId: context.actionId,
      })
      clearSubmitted(vendor.id, submitted, context)
      if (command.changed) recordConnection(context, vendor.id, baseline, auth, "connection")
      if (applied && command.changed) invalidate([vendor.id], context)
      if (refresh && auth.catalogSync?.status !== "pending") await continueRefresh(context, vendor.id, ticket)
      if (parentTicket === undefined) clearActionError(context, ticket)
      return entityCurrent(context, vendor.id) ? store.auth : undefined
    } finally {
      pendingSubmissions.delete(context.actionId)
      keySubmissions.delete(context.actionId)
      for (const field of Object.keys(patch)) {
        if (fieldCommands.get(`${vendor.id}:${field}`) === context.actionId)
          fieldCommands.delete(`${vendor.id}:${field}`)
      }
    }
  }

  const addVendor = async () => {
    if (store.adding) return
    const context = pendingCreate?.context ?? current()
    const ticket = beginAction(context, undefined, "add")
    const raw = pendingCreate?.raw ?? { name: store.addName, baseURL: store.addURL, key: store.addKey }
    const name = raw.name.trim()
    const baseURL = raw.baseURL.trim().replace(/\/+$/, "")
    const key = raw.key.trim()
    if (!name) return
    if (!vendorURLValid(baseURL))
      fail(
        new Error(baseURL ? "provider.custom.error.baseURL.format" : "provider.custom.error.baseURL.required"),
        context,
        ticket,
      )
    if (!key) fail(new Error("KEY_MISSING"), context, ticket)
    addingOwner = context.actionId
    setStore("adding", true)
    try {
      if (!store.auth) {
        const primed = await context.api.get().catch((error) => fail(error, context, ticket))
        if (!active(context)) return
        applyAuth(primed, context)
      }
      requireProtection(context, ticket, undefined, true)
      if (!pendingCreate) {
        const id = vendorIdFromName(
          name,
          store.auth?.vendors.map((vendor) => vendor.id),
        )
        pendingCreate = {
          context,
          raw,
          payload: {
            vendorId: id,
            name,
            baseURL,
            key,
            createOnly: true,
            revision: revision(),
            operationId: commandId(context, "create"),
          },
        }
      }
      const command = pendingCreate
      setStore("addUnconfirmed", true)
      const auth = await call(context, ticket, (api) => api.vendor(command.payload))
      if (!auth) return
      const receipt = auth.operationReceipt
      if (
        !receipt ||
        receipt.operationId !== command.payload.operationId ||
        receipt.vendorId !== command.payload.vendorId
      )
        return fail(new Error("REQUEST_CONFLICT"), context, ticket)
      recordCatalogOutcome(auth, context, ticket, command.payload.vendorId)
      applyAuth(auth, context)
      if (!active(context)) return
      pendingCreate = undefined
      setStore("addUnconfirmed", false)
      if (store.addName === raw.name && store.addURL === raw.baseURL && store.addKey === raw.key)
        setStore({ addName: "", addURL: "", addKey: "" })
      const created = store.auth?.vendors.find(
        (vendor) => vendor.id === receipt.vendorId && vendor.entityId === receipt.entityId,
      )
      setStore("addTargetChanged", !created)
      if (addingOwner === context.actionId) {
        addingOwner = undefined
        setStore("adding", false)
      }
      if (created) {
        context.vendorId = created.id
        vendorErrorOwner.set(created.id, ticket)
        const owner = refreshOwner(created.id)
        if (owner) owner.needed++
        refreshPending()
        if (auth.catalogSync?.status !== "pending") await continueRefresh(context, created.id, ticket)
      }
      clearActionError(context, ticket)
    } catch (error) {
      if (
        active(context) &&
        error instanceof Error &&
        error.message === "REVISION_CONFLICT" &&
        pendingCreate?.context === context
      ) {
        pendingCreate = undefined
        setStore("addUnconfirmed", false)
      }
      throw error
    } finally {
      if (active(context) && addingOwner === context.actionId) {
        addingOwner = undefined
        setStore("adding", false)
      }
    }
  }

  const clearVendorKey = async (vendor: Vendor) => {
    const context = current()
    const ticket = beginAction(context, vendor.id, "key")
    requireProtection(context, ticket, vendor.id)
    const submitted = draft(vendor).key
    const edit = fieldEdits.get(`${vendor.id}:key`) ?? 0
    const baselineVendor = store.auth!.vendors.find((item) => item.id === vendor.id)!
    if (vendor.entityId && vendor.entityId !== baselineVendor.entityId)
      fail(new Error("REQUEST_CONFLICT"), context, ticket, vendor.id)
    const previous = unresolvedClears.get(vendor.id)
    const retry = previous?.baseline.entityId === baselineVendor.entityId ? previous : undefined
    const baseline = retry?.baseline ?? {
      entityId: baselineVendor.entityId,
      revision: baselineVendor.revision,
      precise: supported("vendor-commit-baseline-v1"),
    }
    const payload =
      retry?.payload ??
      Object.freeze({
        vendorId: vendor.id,
        expectedEntityId: baselineVendor.entityId,
        revision: revision(),
        operationId: commandId(context, "key"),
      })
    const command = retry ?? { payload, baseline }
    unresolvedClears.set(vendor.id, command)
    const auth = await call(context, ticket, (api) => api.key(payload))
    if (!auth) return
    if (unresolvedClears.get(vendor.id) === command) unresolvedClears.delete(vendor.id)
    recordCatalogOutcome(auth, context, ticket, vendor.id)
    const applied = applyAuth(auth, context)
    recordConnection(context, vendor.id, baseline, auth, "clear")
    if (applied) invalidate([vendor.id], context)
    const acknowledged = auth.vendors.find((item) => item.id === vendor.id)
    const authoritative = store.auth?.vendors.find((item) => item.id === vendor.id)
    if (
      entityCurrent(context, vendor.id) &&
      acknowledged?.entityId === vendor.entityId &&
      authoritative?.entityId === vendor.entityId &&
      store.drafts[vendor.id]?.key === submitted &&
      (fieldEdits.get(`${vendor.id}:key`) ?? 0) === edit
    )
      setStore("drafts", vendor.id, "key", "")
    clearActionError(context, ticket)
  }

  const deleteVendor = async (vendor: Vendor) => {
    const context = current()
    const ticket = beginAction(context, vendor.id, "delete")
    requireProtection(context, ticket, vendor.id)
    const auth = await call(context, ticket, (api) =>
      api.delete({
        vendorId: vendor.id,
        expectedEntityId: vendor.entityId,
        revision: revision(),
        operationId: commandId(context, "delete"),
      }),
    )
    if (!auth) return
    recordCatalogOutcome(auth, context, ticket, vendor.id)
    if (!applyAuth(auth, context)) return
    if (!store.auth?.vendors.some((item) => item.id === vendor.id)) invalidate([vendor.id], context)
  }

  const persistDraft = async (vendorId: string, parent = current(), parentTicket?: number) => {
    const context = parent
    const ticket = parentTicket ?? beginAction(context, vendorId, "vendor")
    if (!store.auth) {
      const primed = await context.api.get().catch((error) => fail(error, context, ticket))
      if (!active(context)) return
      applyAuth(primed, context)
    }
    const vendor = store.auth?.vendors.find((item) => item.id === vendorId)
    if (!vendor) return
    const next = draft(vendor)
    if (!next.key.trim() && !vendor.hasKey) fail(new Error("KEY_MISSING"), context, ticket)
    requireProtection(context, ticket, vendorId)
    const saved = await saveVendor(vendor, false, context, ticket)
    if (!saved || !entityCurrent(context, vendorId)) return
    if (pendingCatalog.has(vendorId)) return
    const currentVendor = store.auth?.vendors.find((item) => item.id === vendorId)
    if (!currentVendor) return
    const remaining = draft(currentVendor)
    if (
      remaining.key.trim() ||
      remaining.conflicts.length ||
      remaining.name !== remaining.baseline.name ||
      remaining.baseURL !== remaining.baseline.baseURL
    )
      return
    return vendorIdentity(vendorId)
  }

  const probe = async (vendorId: string) => {
    const context = current()
    const ticket = beginAction(context, vendorId, "probe")
    beginBusy("testing", vendorId, context)
    try {
      const identity = await persistDraft(vendorId, context, ticket)
      if (
        !identity ||
        !entityCurrent(context, vendorId) ||
        !sameIdentity(vendorId, identity) ||
        statusOwner.get(vendorId) !== context.actionId
      )
        return
      const result = await context.api
        .probe({ vendorId, expectedEntityId: identity.entityId, expectedVendorRevision: identity.revision })
        .catch((error) => fail(error, context, ticket, vendorId))
      if (!active(context) || statusOwner.get(vendorId) !== context.actionId || !sameIdentity(vendorId, identity))
        return
      const status = result.count > 0 ? "connected" : "empty"
      setStore("status", vendorId, status)
      clearActionError(context, ticket)
      return status
    } finally {
      endBusy("testing", vendorId, context)
      if (entityCurrent(context, vendorId)) void continueRefresh(context, vendorId, ticket).catch(() => undefined)
    }
  }

  const fetchModels = async (vendorId: string) => {
    const context = current()
    const ticket = beginAction(context, vendorId, "fetch")
    beginBusy("fetching", vendorId, context)
    try {
      const identity = await persistDraft(vendorId, context, ticket)
      if (
        !identity ||
        !entityCurrent(context, vendorId) ||
        !sameIdentity(vendorId, identity) ||
        statusOwner.get(vendorId) !== context.actionId
      )
        return
      const owner = refreshOwner(vendorId)
      if (!owner) return
      owner.needed++
      refreshPending()
      await continueRefresh(context, vendorId, ticket, true)
      if (!active(context) || statusOwner.get(vendorId) !== context.actionId || !sameEntity(vendorId, identity)) return
      if (owner.needed > owner.satisfied) return
      const status = vendorCandidates(vendorId).length > 0 ? "connected" : "empty"
      setStore("status", vendorId, status)
      clearActionError(context, ticket)
    } finally {
      endBusy("fetching", vendorId, context)
    }
  }

  const setVisible = (vendorId: string, modelId: string, visible: boolean) => {
    const context = current()
    const identity = vendorIdentity(vendorId)
    if (visibilityGeneration !== generation) {
      visibilityWrite = Promise.resolve()
      visibilityGeneration = generation
    }
    const write = visibilityWrite
      .catch(() => undefined)
      .then(async () => {
        if (!active(context) || !sameEntity(vendorId, identity) || vendorGeneration(vendorId) !== identity.generation)
          return
        const ticket = beginAction(context, vendorId, "visibility")
        requireProtection(context, ticket, vendorId)
        if (supported("catalog-sync-v1")) {
          vendorTicket.set(vendorId, (vendorTicket.get(vendorId) ?? 0) + 1)
          await context.api
            .visibility({ vendorId, modelId, visible, expectedEntityId: identity.entityId })
            .catch((error) => {
              if (
                !entityCurrent(context, vendorId) ||
                !sameEntity(vendorId, identity) ||
                vendorGeneration(vendorId) !== identity.generation
              )
                return
              return fail(error, context, ticket, vendorId)
            })
          if (
            !entityCurrent(context, vendorId) ||
            !sameEntity(vendorId, identity) ||
            vendorGeneration(vendorId) !== identity.generation
          )
            return
          const owner = refreshOwner(vendorId)
          if (!owner) return
          owner.visibility++
          refreshPending()
          return { ticket }
        }
        const baseline = managedWrite.get(vendorId) ?? 0
        const managed = await context.api
          .visibility({ vendorId, modelId, visible, expectedEntityId: identity.entityId })
          .catch((error) => {
            if (
              !entityCurrent(context, vendorId) ||
              !sameEntity(vendorId, identity) ||
              vendorGeneration(vendorId) !== identity.generation
            )
              return
            return fail(error, context, ticket, vendorId)
          })
        if (
          !managed ||
          !entityCurrent(context, vendorId) ||
          !sameEntity(vendorId, identity) ||
          vendorGeneration(vendorId) !== identity.generation
        )
          return
        // A committed checkbox change wins over intervening reads of that model.
        // Preserve newer sibling data, and never apply unrelated vendor snapshots.
        const incoming =
          (managedWrite.get(vendorId) ?? 0) === baseline
            ? managed
            : [
                ...store.managed.filter((item) => item.vendorId === vendorId && item.modelId !== modelId),
                ...managed.filter((item) => item.vendorId === vendorId && item.modelId === modelId),
              ]
        vendorTicket.set(vendorId, (vendorTicket.get(vendorId) ?? 0) + 1)
        requestSeq += 1
        managedWrite.set(vendorId, requestSeq)
        setStore("managed", replaceVendor(store.managed, incoming, vendorId))
        clearActionError(context, ticket)
      })
    visibilityWrite = write.then(
      () => undefined,
      () => undefined,
    )
    return write.then(async (committed) => {
      if (!committed) return
      await continueVisibility(context, vendorId, committed.ticket).catch((error) =>
        fail(error, context, committed.ticket, vendorId),
      )
      clearActionError(context, committed.ticket)
    })
  }

  const newDraft = (vendor: Vendor): Draft => ({
    name: vendor.name,
    baseURL: vendor.baseURL ?? "",
    key: "",
    baseline: { name: vendor.name, baseURL: vendor.baseURL ?? "" },
    conflicts: [],
    entity: vendorEntities.get(vendor.id) ?? 0,
  })

  const draft = (vendor: Vendor) => store.drafts[vendor.id] ?? newDraft(vendor)

  const setDraft = (vendorId: string, field: "name" | "baseURL" | "key", value: string) => {
    const vendor = (store.auth?.vendors ?? defaultVendors).find((item) => item.id === vendorId)
    if (!vendor) return
    const currentDraft = draft(vendor)
    fieldEdits.set(`${vendorId}:${field}`, (fieldEdits.get(`${vendorId}:${field}`) ?? 0) + 1)
    setStore("drafts", vendorId, {
      ...currentDraft,
      [field]: value,
      baseline: { ...currentDraft.baseline, ...(field === "key" ? {} : { [field]: vendor[field] ?? "" }) },
      conflicts: currentDraft.conflicts.filter((item) => item !== field),
    })
  }

  const dispose = () => {
    disposed = true
    alive = false
    generation += 1
    retireRefresh()
    busy.clear()
    setStore("testing", reconcile({}))
    setStore("fetching", reconcile({}))
    pendingCreate = undefined
    keySubmissions.clear()
    fieldCommands.clear()
    pendingSubmissions.clear()
    unresolvedSaves.clear()
    unresolvedClears.clear()
  }

  onCleanup(dispose)

  return {
    store,
    isBusy: (kind: "testing" | "fetching", vendorId: string) => store[kind][vendorId] === true,
    vendors: () => store.auth?.vendors ?? defaultVendors,
    setStore,
    resource,
    reload: async () => {
      if (disposed) return
      const next = scope()
      if (next !== seenScope) {
        seenScope = next
        resetForScope()
      }
      const context = current()
      const deadlines = new Map([...refreshOwners].map(([id, owner]) => [id, owner.lane.deadline()]))
      const pending = [...refreshOwners].find(
        ([, owner]) => owner.needed > owner.satisfied || owner.visibility > owner.visibilityCovered,
      )
      const loaded = await load(
        true,
        pending ? boundedContext(context, pending[1], deadlines.get(pending[0])!) : context,
      )
      if (!loaded || !active(context)) return
      const ticket = issueTicket()
      await Promise.all(
        [...refreshOwners.keys()].map(async (id) => {
          vendorErrorOwner.set(id, ticket)
          await continueVisibility(context, id, ticket, deadlines.get(id))
          // A full read must not wait for the vendor read it has just superseded.
          if (!refreshOwners.get(id)?.running.size) await continueRefresh(context, id, ticket, true, deadlines.get(id))
        }),
      )
    },
    canEdit: () => supported("independent-vendors-v1") && supported("vendor-entity-v1"),
    canAdd: () => supported("independent-vendors-v1") && supported("vendor-create-receipt-v1"),
    applyAuth: (auth: Auth) => applyAuth(auth, current()),
    visibleCount,
    vendorCandidates,
    isVisible,
    draft,
    setDraft,
    saveVendor: async (vendor: Vendor, refresh = true) => {
      await saveVendor(vendor, refresh)
    },
    addVendor,
    clearVendorKey,
    deleteVendor,
    probe,
    fetchModels,
    setVisible,
    load: () => initial ?? load(),
    dispose,
    resetScope: resetForScope,
  }

  function visibleCount(vendorId: string) {
    return store.managed.filter((item) => item.vendorId === vendorId && item.visible).length
  }

  function vendorCandidates(vendorId: string) {
    return store.candidates.filter((item) => item.vendorId === vendorId)
  }

  function isVisible(vendorId: string, modelId: string) {
    return store.managed.some((item) => item.vendorId === vendorId && item.modelId === modelId && item.visible)
  }
}

export function useRelaySettings() {
  const serverSDK = useServerSDK()
  return createRelaySettingsState(serverSDK)
}
