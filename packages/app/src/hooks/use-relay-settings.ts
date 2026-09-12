import { createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import type {
  ServerRelayCandidatesOutput,
  ServerRelayGetOutput,
  ServerRelayManagedOutput,
} from "../../../client/src/generated/types"

type Auth = ServerRelayGetOutput
type Candidate = ServerRelayCandidatesOutput[number]
type Managed = ServerRelayManagedOutput[number]
type Vendor = Auth["vendors"][number]

const ERROR_KEYS = [
  "KEY_MISSING",
  "KEY_REJECTED",
  "UPSTREAM_UNREACHABLE",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_RATE_LIMITED",
  "UPSTREAM_INVALID_RESPONSE",
  "REVISION_CONFLICT",
  "SECRET_STORE_UNAVAILABLE",
] as const

type RelayErrorKey = `settings.relay.error.${(typeof ERROR_KEYS)[number]}` | "common.requestFailed"

export function vendorIdFromName(name: string) {
  const id = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (id) return id
  return `vendor-${Date.now()}`
}

export function relayErrorKey(error: unknown): RelayErrorKey {
  const message = error && typeof error === "object" && "message" in error ? String(error.message) : ""
  if ((ERROR_KEYS as readonly string[]).includes(message)) return `settings.relay.error.${message}` as RelayErrorKey
  return "common.requestFailed"
}

export function useRelaySettings() {
  const serverSDK = useServerSDK()
  const [store, setStore] = createStore({
    auth: undefined as Auth | undefined,
    candidates: [] as Candidate[],
    managed: [] as Managed[],
    error: undefined as ReturnType<typeof relayErrorKey> | undefined,
    testing: undefined as string | undefined,
    fetching: undefined as string | undefined,
    drafts: {} as Record<string, { name: string; key: string }>,
    unifiedKey: "",
    addName: "",
    addKey: "",
    status: {} as Record<string, string>,
    open: undefined as string | undefined,
  })

  const relay = () => serverSDK().generatedApi["server.relay"]
  const revision = () => store.auth?.revision ?? 0
  const op = () => crypto.randomUUID()

  const applyAuth = (auth: Auth) => {
    setStore("auth", auth)
    setStore("drafts", {})
    setStore("unifiedKey", "")
    setStore("addName", "")
    setStore("addKey", "")
  }

  const load = async () => {
    try {
      const [auth, candidates, managed] = await Promise.all([relay().get(), relay().candidates(), relay().managed()])
      applyAuth(auth)
      setStore("candidates", [...candidates])
      setStore("managed", [...managed])
      setStore("error", undefined)
    } catch (error) {
      setStore("error", relayErrorKey(error))
      throw error
    }
  }

  const [resource, { refetch }] = createResource(load)

  const fail = (error: unknown): never => {
    setStore("error", relayErrorKey(error))
    throw error
  }

  const visibleCount = (vendorId: string) =>
    store.managed.filter((item) => item.vendorId === vendorId && item.visible).length

  const vendorCandidates = (vendorId: string) => store.candidates.filter((item) => item.vendorId === vendorId)

  const isVisible = (vendorId: string, modelId: string) =>
    store.managed.some((item) => item.vendorId === vendorId && item.modelId === modelId && item.visible)

  const draft = (vendor: Vendor) => store.drafts[vendor.id] ?? { name: vendor.name, key: "" }

  const setDraft = (vendorId: string, field: "name" | "key", value: string) => {
    const current = store.drafts[vendorId] ?? {
      name: store.auth?.vendors.find((item) => item.id === vendorId)?.name ?? "",
      key: "",
    }
    setStore("drafts", { ...store.drafts, [vendorId]: { ...current, [field]: value } })
  }

  const setMode = async (unified: boolean) => {
    applyAuth(await relay().mode({ unified, revision: revision(), operationId: op() }).catch(fail))
  }

  const saveUnified = async () => {
    const key = store.unifiedKey.trim()
    applyAuth(
      await relay()
        .unified({ ...(key ? { key } : {}), revision: revision(), operationId: op() })
        .catch(fail),
    )
  }

  const clearUnified = async () => {
    applyAuth(await relay().clear({ revision: revision(), operationId: op() }).catch(fail))
  }

  const saveVendor = async (vendor: Vendor) => {
    const next = draft(vendor)
    applyAuth(
      await relay()
        .vendor({
          vendorId: vendor.id,
          name: next.name.trim() || vendor.name,
          ...(next.key.trim() ? { key: next.key.trim() } : {}),
          revision: revision(),
          operationId: op(),
        })
        .catch(fail),
    )
  }

  const addVendor = async () => {
    const name = store.addName.trim()
    if (!name) return
    const id = vendorIdFromName(name)
    applyAuth(
      await relay()
        .vendor({
          vendorId: id,
          name,
          ...(store.addKey.trim() ? { key: store.addKey.trim() } : {}),
          revision: revision(),
          operationId: op(),
        })
        .catch(fail),
    )
  }

  const clearVendorKey = async (vendor: Vendor) => {
    applyAuth(await relay().key({ vendorId: vendor.id, revision: revision(), operationId: op() }).catch(fail))
  }

  const rollback = async () => {
    applyAuth(await relay().rollback({ revision: revision(), operationId: op() }).catch(fail))
  }

  const deleteVendor = async (vendor: Vendor) => {
    applyAuth(await relay().delete({ vendorId: vendor.id, revision: revision(), operationId: op() }).catch(fail))
  }

  const persistDraft = async (vendorId: string) => {
    const vendor = store.auth?.vendors.find((item) => item.id === vendorId)
    if (!vendor) return
    const next = draft(vendor)
    if (!next.key.trim() && !vendor.hasKey && !store.auth?.hasUnifiedKey) return
    await saveVendor(vendor)
  }

  const probe = async (vendorId: string) => {
    setStore("testing", vendorId)
    try {
      await persistDraft(vendorId)
      const result = await relay().probe({ vendorId }).catch(fail)
      const status = result.count > 0 ? "connected" : "empty"
      setStore("status", vendorId, status)
      return status
    } finally {
      setStore("testing", undefined)
    }
  }

  const fetchModels = async (vendorId: string) => {
    setStore("fetching", vendorId)
    try {
      await persistDraft(vendorId)
      const candidates = await relay().refresh({ vendorId }).catch(fail)
      setStore("candidates", [...candidates])
      setStore("managed", [...(await relay().managed())])
      setStore("status", vendorId, candidates.filter((item) => item.vendorId === vendorId).length > 0 ? "connected" : "empty")
    } finally {
      setStore("fetching", undefined)
    }
  }

  const setVisible = async (vendorId: string, modelId: string, visible: boolean) => {
    setStore("managed", [...(await relay().visibility({ vendorId, modelId, visible }).catch(fail))])
  }

  return {
    store,
    setStore,
    resource,
    reload: refetch,
    applyAuth,
    visibleCount,
    vendorCandidates,
    isVisible,
    draft,
    setDraft,
    setMode,
    saveUnified,
    clearUnified,
    saveVendor,
    addVendor,
    clearVendorKey,
    deleteVendor,
    rollback,
    probe,
    fetchModels,
    setVisible,
  }
}
