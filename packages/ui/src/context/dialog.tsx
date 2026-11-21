import {
  createContext,
  createEffect,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  type Owner,
  type ParentProps,
  runWithOwner,
  useContext,
  type JSX,
  startTransition,
  For,
} from "solid-js"
import { Dialog as Kobalte } from "@kobalte/core/dialog"

type DialogElement = () => JSX.Element

type Active = {
  id: string
  node: JSX.Element
  dispose: () => void
  owner: Owner
  onClose?: () => void
  setClosing: (closing: boolean) => void
  layer: number
  closing: boolean
  disposed: boolean
  timer?: ReturnType<typeof setTimeout>
}

const Context = createContext<ReturnType<typeof init>>()
const InstanceContext = createContext<string>()

export function bindDialog<T extends Record<string, unknown>>(element: DialogElement, id: string) {
  const bound = (() => element()) as DialogElement & { __dialogID?: string }
  bound.__dialogID = id
  return bound
}

export function dialogBinding(element: DialogElement) {
  return (element as DialogElement & { __dialogID?: string }).__dialogID
}

function init() {
  const [stack, setStack] = createSignal<Active[]>([])
  const lifecycle = { disposed: false }
  const disposeDialog = (item: Active) => {
    if (item.disposed) return
    item.disposed = true
    if (item.timer !== undefined) {
      clearTimeout(item.timer)
      item.timer = undefined
    }
    item.dispose()
  }

  onCleanup(() => {
    lifecycle.disposed = true
    const items = stack()
    setStack([])
    for (const item of items) disposeDialog(item)
  })

  const close = (id?: string) => {
    const items = stack()
    const current = id ? items.find((item) => item.id === id) : items.at(-1)
    if (!current || current.closing || current.disposed) return
    current.closing = true
    // Register the timer before callbacks can replace or dispose this instance.
    current.timer = setTimeout(() => {
      current.timer = undefined
      setStack((items) => items.filter((item) => item !== current))
      disposeDialog(current)
    }, 100)
    current.setClosing(true)
    current.onClose?.()
  }

  const mount = (element: DialogElement, owner: Owner, onClose: (() => void) | undefined, layer: number) => {
    if (lifecycle.disposed) return
    const id = dialogBinding(element) ?? Math.random().toString(36).slice(2)
    const zIndex = 50 + layer * 10
    let dispose: (() => void) | undefined
    let setClosing: ((closing: boolean) => void) | undefined

    const node = runWithOwner(owner, () =>
      createRoot((d: () => void) => {
        dispose = d
        const [closing, setClosingSignal] = createSignal(false)
        setClosing = setClosingSignal
        return (
          <Kobalte
            modal={stack().at(-1)?.id === id}
            open={!closing()}
            onOpenChange={(open: boolean) => {
              if (open || stack().at(-1)?.id !== id) return
              close(id)
            }}
          >
            <Kobalte.Portal>
              <Kobalte.Overlay data-component="dialog-overlay" style={{ "z-index": String(zIndex) }} />
              <div
                data-dialog-layer={layer}
                data-dialog-id={id}
                style={{
                  position: "fixed",
                  inset: "0",
                  "z-index": String(zIndex),
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                  "pointer-events": "none",
                }}
              >
                <InstanceContext.Provider value={id}>{element()}</InstanceContext.Provider>
              </div>
            </Kobalte.Portal>
          </Kobalte>
        )
      }),
    )

    if (!dispose || !setClosing) return

    queueMicrotask(() => {
      if (active.disposed) return
      const overlay = document
        .querySelector(`[data-dialog-id="${id}"]`)
        ?.parentElement?.querySelector("[data-component='dialog-overlay']")
      // Kobalte strips unknown props before they reach the overlay, so the close listener is attached after mount.
      overlay?.addEventListener("click", () => close(id))
    })

    const active: Active = { id, node, dispose, owner, onClose, setClosing, layer, closing: false, disposed: false }
    setStack((items) => [...items, active])
  }

  const push = (element: DialogElement, owner: Owner, onClose?: () => void) => {
    mount(element, owner, onClose, (stack().at(-1)?.layer ?? -1) + 1)
  }

  const show = (element: DialogElement, owner: Owner, onClose?: () => void) => {
    const items = stack()
    setStack([])
    for (const item of items) disposeDialog(item)
    mount(element, owner, onClose, 0)
  }

  return {
    stack,
    close,
    show,
    push,
  }
}

export function DialogProvider(props: ParentProps) {
  const ctx = init()
  return (
    <Context.Provider value={ctx}>
      {props.children}
      <div data-component="dialog-stack" data-dialog-count={ctx.stack().length}>
        <For each={ctx.stack()}>{(item) => item.node}</For>
      </div>
    </Context.Provider>
  )
}

// Nested controls inherit only their own active dialog's modality.
export function useDialogModal() {
  const ctx = useContext(Context)
  const id = useContext(InstanceContext)
  return () => id !== undefined && ctx?.stack().at(-1)?.id === id
}

export function useDialog() {
  const ctx = useContext(Context)
  const owner = getOwner()
  const captured = { id: useContext(InstanceContext) }
  createEffect(() => {
    captured.id = useContext(InstanceContext) ?? captured.id
  })

  if (!owner) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  if (!ctx) {
    throw new Error("useDialog must be used within a DialogProvider")
  }

  return {
    get active() {
      return ctx.stack().at(-1)
    },
    show(element: DialogElement, onClose?: () => void) {
      const base = ctx.stack().at(-1)?.owner ?? owner
      ctx.show(element, base, onClose)
      return startTransition(() => undefined)
    },
    push(element: DialogElement, onClose?: () => void) {
      const base = ctx.stack().at(-1)?.owner ?? owner
      ctx.push(element, base, onClose)
      return startTransition(() => undefined)
    },
    close(id?: string) {
      ctx.close(id ?? captured.id)
    },
  }
}
