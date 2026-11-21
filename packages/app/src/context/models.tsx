import { type Accessor, createMemo, createResource, onCleanup } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import { DateTime } from "luxon"
import { filter, firstBy, flat, groupBy, mapValues, pipe, uniqueBy, values } from "remeda"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"

export type ModelKey = { providerID: string; modelID: string }

type Visibility = "show" | "hide"
type User = ModelKey & { visibility: Visibility; favorite?: boolean }
type Store = {
  user: User[]
  recent: ModelKey[]
  variant?: Record<string, string | undefined>
}

const RECENT_LIMIT = 5
const modelStores = new Map<string, { store: Store; setStore: SetStoreFunction<Store>; listeners: Set<() => void> }>()

function modelKey(model: ModelKey) {
  return `${model.providerID}:${model.modelID}`
}

function sharedModelStore(key: string) {
  const existing = modelStores.get(key)
  if (existing) return existing
  const [store, setStore] = createStore<Store>({ user: [], recent: [], variant: {} })
  const created = { store, setStore, listeners: new Set<() => void>() }
  modelStores.set(key, created)
  return created
}

export const { use: useModels, provider: ModelsProvider } = createSimpleContext({
  name: "Models",
  gate: false,
  init: (props: { directory?: Accessor<string | undefined> } = {}) => {
    const providers = useProviders(() => props.directory?.())

    const preferenceKey = Persist.global("model", ["model.v1"]).key
    const shared = sharedModelStore(preferenceKey)
    const [, setPersistedStore, _, ready] = persisted(Persist.global("model", ["model.v1"]), [
      shared.store,
      shared.setStore,
    ])
    const store = shared.store
    const setStore = shared.setStore
    const writePreference = () =>
      setPersistedStore({
        user: [...shared.store.user],
        recent: [...shared.store.recent],
        variant: { ...shared.store.variant },
      })
    const publish = () => {
      for (const listener of shared.listeners) listener()
    }
    shared.listeners.add(writePreference)
    onCleanup(() => {
      shared.listeners.delete(writePreference)
    })

    const available = createMemo(() =>
      providers.connected().flatMap((p) =>
        Object.values(p.models)
          .filter((m) => m.id !== "grok-4" && !(p.id === "openai" && /^gpt-5\.[23]-codex(?:$|-)/i.test(m.id)))
          .map((m) => ({ ...m, provider: p })),
      ),
    )

    const release = createMemo(
      () =>
        new Map(
          available().map((model) => {
            const parsed = DateTime.fromISO(model.release_date)
            return [modelKey({ providerID: model.provider.id, modelID: model.id }), parsed] as const
          }),
        ),
    )

    const latest = createMemo(() =>
      pipe(
        available(),
        filter(
          (x) =>
            Math.abs(
              (release().get(modelKey({ providerID: x.provider.id, modelID: x.id })) ?? DateTime.invalid("invalid"))
                .diffNow()
                .as("months"),
            ) < 6,
        ),
        groupBy((x) => x.provider.id),
        mapValues((models) =>
          pipe(
            models,
            groupBy((x) => x.family),
            values(),
            (groups) =>
              groups.flatMap((g) => {
                const first = firstBy(g, [(x) => x.release_date, "desc"])
                return first ? [{ modelID: first.id, providerID: first.provider.id }] : []
              }),
          ),
        ),
        values(),
        flat(),
      ),
    )

    const latestSet = createMemo(() => new Set(latest().map((x) => modelKey(x))))

    const visibility = createMemo(() => {
      const map = new Map<string, Visibility>()
      for (const item of store.user) map.set(`${item.providerID}:${item.modelID}`, item.visibility)
      return map
    })

    const list = createMemo(() =>
      available().map((m) => ({
        ...m,
        name: m.name.replace("(latest)", "").trim(),
        latest: m.name.includes("(latest)"),
      })),
    )

    const find = (key: ModelKey) => list().find((m) => m.id === key.modelID && m.provider.id === key.providerID)

    function update(model: ModelKey, state: Visibility) {
      const index = store.user.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)
      if (index >= 0) {
        setStore("user", index, (current) => ({ ...current, visibility: state }))
        publish()
        return
      }
      setStore("user", store.user.length, { ...model, visibility: state })
      publish()
    }

    const visible = (model: ModelKey) => {
      const key = modelKey(model)
      const state = visibility().get(key)
      if (state === "hide") return false
      if (state === "show") return true
      if (model.providerID === "leidiandonghua") return true
      if (latestSet().has(key)) return true
      const date = release().get(key)
      if (!date?.isValid) return true
      return false
    }

    const setVisibility = (model: ModelKey, state: boolean) => {
      update(model, state ? "show" : "hide")
    }

    const push = (model: ModelKey) => {
      const uniq = uniqueBy([model, ...store.recent], (x) => `${x.providerID}:${x.modelID}`)
      if (uniq.length > RECENT_LIMIT) uniq.pop()
      setStore("recent", uniq)
      publish()
    }

    const variantKey = (model: ModelKey) => `${model.providerID}/${model.modelID}`
    const getVariant = (model: ModelKey) => store.variant?.[variantKey(model)]

    const setVariant = (model: ModelKey, value: string | undefined) => {
      const key = variantKey(model)
      if (!store.variant) {
        setStore("variant", { [key]: value })
        publish()
        return
      }
      setStore("variant", key, value)
      publish()
    }

    const [recentModels] = createResource(
      async () => {
        const recent = store.recent
        await ready.promise
        return recent
      },
      (p) => p,
      { initialValue: [] },
    )
    return {
      ready,
      list,
      find,
      visible,
      setVisibility,
      recent: {
        list: () => recentModels()!,
        push,
      },
      variant: {
        get: getVariant,
        set: setVariant,
      },
    }
  },
})
