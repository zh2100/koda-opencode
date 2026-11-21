import { useDialogModal } from "../context/dialog"
import { Popover as Kobalte } from "@kobalte/core/popover"
import { ComponentProps, JSXElement, ParentProps, Show, splitProps, ValidComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { useI18n } from "../context/i18n"
import { IconButton } from "./icon-button"

export interface PopoverProps<T extends ValidComponent = "div">
  extends ParentProps,
    Omit<ComponentProps<typeof Kobalte>, "children"> {
  trigger?: JSXElement
  triggerAs?: T
  triggerProps?: ComponentProps<T>
  title?: JSXElement
  description?: JSXElement
  class?: ComponentProps<"div">["class"]
  classList?: ComponentProps<"div">["classList"]
  style?: ComponentProps<"div">["style"]
  portal?: boolean
}

export function Popover<T extends ValidComponent = "div">(props: PopoverProps<T>) {
  const modal = useDialogModal()
  const i18n = useI18n()
  const [local, rest] = splitProps(props, [
    "trigger",
    "triggerAs",
    "triggerProps",
    "title",
    "description",
    "class",
    "classList",
    "style",
    "children",
    "portal",
    "open",
    "defaultOpen",
    "onOpenChange",
    "modal",
  ])

  const [state, setState] = createStore({
    dismiss: null as "escape" | "outside" | null,
    uncontrolledOpen: local.defaultOpen ?? false,
  })

  const controlled = () => local.open !== undefined
  const opened = () => {
    if (controlled()) return local.open ?? false
    return state.uncontrolledOpen
  }

  const onOpenChange = (next: boolean) => {
    if (next) setState("dismiss", null)
    if (local.onOpenChange) local.onOpenChange(next)
    if (controlled()) return
    setState("uncontrolledOpen", next)
  }

  const content = () => (
    <Kobalte.Content
      data-component="popover-content"
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      style={local.style}
      onEscapeKeyDown={() => setState("dismiss", "escape")}
      onInteractOutside={(event) => {
        if (!event.defaultPrevented) setState("dismiss", "outside")
      }}
      onCloseAutoFocus={(event: Event) => {
        if (state.dismiss === "outside") event.preventDefault()
        setState("dismiss", null)
      }}
    >
      {/* <Kobalte.Arrow data-slot="popover-arrow" /> */}
      <Show when={local.title}>
        <div data-slot="popover-header">
          <Kobalte.Title data-slot="popover-title">{local.title}</Kobalte.Title>
          <Kobalte.CloseButton
            data-slot="popover-close-button"
            as={IconButton}
            icon="close"
            variant="ghost"
            aria-label={i18n.t("ui.common.close")}
          />
        </div>
      </Show>
      <Show when={local.description}>
        <Kobalte.Description data-slot="popover-description">{local.description}</Kobalte.Description>
      </Show>
      <div data-slot="popover-body">{local.children}</div>
    </Kobalte.Content>
  )

  return (
    <Kobalte gutter={4} {...rest} open={opened()} onOpenChange={onOpenChange} modal={local.modal ?? modal()}>
      <Kobalte.Trigger as={local.triggerAs ?? "div"} data-slot="popover-trigger" {...(local.triggerProps as any)}>
        {local.trigger}
      </Kobalte.Trigger>
      <Show when={local.portal ?? true} fallback={content()}>
        <Kobalte.Portal>{content()}</Kobalte.Portal>
      </Show>
    </Kobalte>
  )
}
