import { createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import { relayErrorKey, vendorIdFromName, vendorURLValid } from "./relay-settings"
export { relayErrorKey, vendorIdFromName, vendorURLValid } from "./relay-settings"
import type {
  ServerRelayCandidatesOutput,
  ServerRelayGetOutput,
  ServerRelayManagedOutput,
} from "../../../client/src/generated/types"

type Auth = ServerRelayGetOutput
type Candidate = ServerRelayCandidatesOutput[number]
type Managed = ServerRelayManagedOutput[number]
type Vendor = Auth["vendors"][number]

export function useRelaySettings() {
  const serverSDK = useServerSDK()
  const [store, setStore] = createStore({
    auth: undefined as Auth | undefined,
    candidates: [] as Candidate[],
    managed: [] as Managed[],
    error: undefined as ReturnType<typeof relayErrorKey> | undefined,
    testing: undefined as string | undefined,
    fetching: undefined as string | undefined,
    drafts: {} as Record<string, { name: string; baseURL: string; key: string }>,
    unifiedKey: "",
    addName: "",
    addURL: "",
    addKey: "",
    status: {} as Record<string, string>,
    open: undefined as string | undefined,
  })

  const relay = () => serverSDK().generatedApi["server.relay"]
  const revision = () => store.auth?.revision ?? 0
  const op = () => crypto.randomUUID()
  const invalidated = new Set<string>()
  let catalogVersion = 0

  const invalidate = (ids: readonly string[]) => {
    catalogVersion += 1
    ids.forEach((id) => {
      invalidated.add(id)
      setStore("status", id, "")
    })
    setStore("candidates", (items) => items.filter((item) => !item.vendorId || !invalidated.has(item.vendorId)))
    setStore("managed", (items) => items.filter((item) => !invalidated.has(item.vendorId)))
  }

  const loadCatalog = async (vendorId?: string) => {
    const version = catalogVersion
    const candidates = await (vendorId
      ? relay()
          .refresh({ vendorId })
          .then(() => relay().candidates({ vendorId }))
      : relay().candidates()
    ).catch(fail)
    const managed = await relay().managed().catch(fail)
    if (version !== catalogVersion) return
    if (vendorId) invalidated.delete(vendorId)
    setStore("candidates", (items) =>
      vendorId
        ? [
            ...items.filter((item) => item.vendorId !== vendorId),
            ...candidates.filter((item) => item.vendorId === vendorId),
          ]
        : candidates.filter((item) => !item.vendorId || !invalidated.has(item.vendorId)),
    )
    setStore(
      "managed",
      managed.filter((item) => !invalidated.has(item.vendorId)),
    )
  }

  const applyAuth = (auth: Auth) => {
    setStore("auth", auth)
    setStore("error", undefined)
  }

  const load = async () => {
    try {
      applyAuth(await relay().get())
      await loadCatalog()
      setStore("error", undefined)
    } catch (error) {
      setStore("error", relayErrorKey(error))
      throw error
    }
  }

  const fail = (error: unknown): never => {
    setStore("error", relayErrorKey(error))
    throw error
  }

  const [resource, { refetch }] = createResource(load)

  const visibleCount = (vendorId: string) =>
    store.managed.filter((item) => item.vendorId === vendorId && item.visible).length

  const vendorCandidates = (vendorId: string) => store.candidates.filter((item) => item.vendorId === vendorId)

  const isVisible = (vendorId: string, modelId: string) =>
    store.managed.some((item) => item.vendorId === vendorId && item.modelId === modelId && item.visible)

  const draft = (vendor: Vendor) =>
    store.drafts[vendor.id] ?? { name: vendor.name, baseURL: vendor.baseURL ?? "", key: "" }

  const setDraft = (vendorId: string, field: "name" | "baseURL" | "key", value: string) => {
    const current = store.drafts[vendorId] ?? {
      name: store.auth?.vendors.find((item) => item.id === vendorId)?.name ?? "",
      baseURL: store.auth?.vendors.find((item) => item.id === vendorId)?.baseURL ?? "",
      key: "",
    }
    setStore("drafts", { ...store.drafts, [vendorId]: { ...current, [field]: value } })
  }

  const setMode = async (unified: boolean) => {
    applyAuth(await relay().mode({ unified, revision: revision(), operationId: op() }).catch(fail))
    invalidate(store.auth?.vendors.filter((vendor) => !vendor.baseURL).map((vendor) => vendor.id) ?? [])
  }

  const saveUnified = async () => {
    const key = store.unifiedKey.trim()
    applyAuth(
      await relay()
        .unified({ ...(key ? { key } : {}), revision: revision(), operationId: op() })
        .catch(fail),
    )
    if (store.unifiedKey.trim() === key) setStore("unifiedKey", "")
    invalidate(store.auth?.vendors.filter((vendor) => !vendor.baseURL).map((vendor) => vendor.id) ?? [])
  }

  const clearUnified = async () => {
    applyAuth(await relay().clear({ revision: revision(), operationId: op() }).catch(fail))
    invalidate(store.auth?.vendors.filter((vendor) => !vendor.baseURL).map((vendor) => vendor.id) ?? [])
  }

  const saveVendor = async (vendor: Vendor, refresh = true) => {
    const next = { ...draft(vendor) }
    const baseURL = next.baseURL.trim().replace(/\/+$/, "")
    const changed = !!next.key.trim() || (!vendor.builtin && baseURL !== (vendor.baseURL ?? ""))
    if (!vendor.builtin && (baseURL || vendor.baseURL) && !vendorURLValid(baseURL))
      fail(new Error(baseURL ? "provider.custom.error.baseURL.format" : "provider.custom.error.baseURL.required"))
    if (!store.auth) setStore("auth", await relay().get().catch(fail))
    applyAuth(
      await relay()
        .vendor({
          vendorId: vendor.id,
          name: next.name.trim() || vendor.name,
          ...(!vendor.builtin && baseURL ? { baseURL } : {}),
          ...(next.key.trim() ? { key: next.key.trim() } : {}),
          revision: revision(),
          operationId: op(),
        })
        .catch(fail),
    )
    if (changed) invalidate([vendor.id])
    if (draft(vendor).key === next.key) setDraft(vendor.id, "key", "")
    if (store.auth?.unified && !baseURL) await setMode(false)
    if (refresh && changed && (next.key.trim() || vendor.hasKey)) await loadCatalog(vendor.id)
  }

  const addVendor = async () => {
    const name = store.addName.trim()
    if (!name) return
    const baseURL = store.addURL.trim().replace(/\/+$/, "")
    const key = store.addKey.trim()
    if (!vendorURLValid(baseURL))
      fail(new Error(baseURL ? "provider.custom.error.baseURL.format" : "provider.custom.error.baseURL.required"))
    if (!key) fail(new Error("KEY_MISSING"))
    if (!store.auth) applyAuth(await relay().get().catch(fail))
    const id = vendorIdFromName(
      name,
      store.auth?.vendors.map((vendor) => vendor.id),
    )
    applyAuth(
      await relay()
        .vendor({
          vendorId: id,
          name,
          baseURL,
          key,
          revision: revision(),
          operationId: op(),
        })
        .catch(fail),
    )
    if (
      store.addName.trim() === name &&
      store.addURL.trim().replace(/\/+$/, "") === baseURL &&
      store.addKey.trim() === key
    )
      setStore({ addName: "", addURL: "", addKey: "" })
    await loadCatalog(id)
  }

  const clearVendorKey = async (vendor: Vendor) => {
    const key = draft(vendor).key
    applyAuth(await relay().key({ vendorId: vendor.id, revision: revision(), operationId: op() }).catch(fail))
    invalidate([vendor.id])
    if (draft(vendor).key === key) setDraft(vendor.id, "key", "")
  }

  const rollback = async () => {
    applyAuth(await relay().rollback({ revision: revision(), operationId: op() }).catch(fail))
    invalidate(store.auth?.vendors.map((vendor) => vendor.id) ?? [])
  }

  const deleteVendor = async (vendor: Vendor) => {
    applyAuth(await relay().delete({ vendorId: vendor.id, revision: revision(), operationId: op() }).catch(fail))
    invalidate([vendor.id])
  }

  const persistDraft = async (vendorId: string) => {
    if (!store.auth) setStore("auth", await relay().get().catch(fail))
    const vendor = store.auth?.vendors.find((item) => item.id === vendorId)
    if (!vendor) return
    const next = draft(vendor)
    if (!next.key.trim() && !vendor.hasKey) fail(new Error("KEY_MISSING"))
    await saveVendor(vendor, false)
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
      await loadCatalog(vendorId)
      setStore("status", vendorId, vendorCandidates(vendorId).length > 0 ? "connected" : "empty")
    } finally {
      setStore("fetching", undefined)
    }
  }

  const setVisible = async (vendorId: string, modelId: string, visible: boolean) => {
    const managed = await relay().visibility({ vendorId, modelId, visible }).catch(fail)
    setStore(
      "managed",
      managed.filter((item) => !invalidated.has(item.vendorId)),
    )
  }

  return {
    store,
    vendors: () =>
      store.auth?.vendors ?? [
        { id: "chatgpt", name: "ChatGPT", builtin: true, hasKey: false, revision: 0, updatedAt: 0 },
        { id: "claude", name: "Claude", builtin: true, hasKey: false, revision: 0, updatedAt: 0 },
        { id: "gemini", name: "Gemini", builtin: true, hasKey: false, revision: 0, updatedAt: 0 },
        { id: "grok", name: "Grok", builtin: true, hasKey: false, revision: 0, updatedAt: 0 },
        { id: "kimi", name: "Kimi", builtin: true, hasKey: false, revision: 0, updatedAt: 0 },
      ],
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
