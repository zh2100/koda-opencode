import { NestedControls } from "./nested"
import { Show, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { bindDialog, DialogProvider, useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogV2, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Popover } from "@kobalte/core/popover"
import "../../../src/index.css"

const [state, setState] = createStore({ mounted: true, closed: [] as string[], disposed: [] as string[] })

function Launcher() {
  const dialogs = useDialog()
  const open = (name: string, push = false, id = name.toLowerCase()) => {
    const element = bindDialog(() => <Panel name={name} id={id} />, id)
    dialogs[push ? "push" : "show"](element, () => setState("closed", (items) => [...items, name]))
  }
  function Panel(props: { name: string; id: string }) {
    const own = useDialog()
    onCleanup(() => setState("disposed", (items) => [...items, props.name]))
    return (
      <DialogV2>
        <DialogHeader>
          <DialogTitle>{props.name}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <label>
            {props.name} draft
            <input aria-label={props.name + " draft"} autofocus />
          </label>
          <Show when={props.name === "Lower"}>
            <button onClick={() => open("Upper", true)}>Open upper</button>
            <button
              onClick={() => {
                own.close()
                open("Upper", true)
              }}
            >
              Close lower and push upper
            </button>
            <button
              onClick={() => {
                own.close()
                open("Replacement", false, props.id)
              }}
            >
              Replace while closing
            </button>
          </Show>
          <Show when={props.name === "Upper"}>
            <button
              onClick={() => {
                dialogs.close("lower")
                own.close()
              }}
            >
              Close both lower first
            </button>
            <button
              onClick={() => {
                own.close()
                dialogs.close("lower")
              }}
            >
              Close both upper first
            </button>
            <button
              onClick={() => {
                dialogs.close("lower")
                setState("mounted", false)
              }}
            >
              Unmount while lower closes
            </button>
          </Show>
        </DialogBody>
        <DialogFooter>
          <button onClick={() => own.close()}>Close this</button>
        </DialogFooter>
      </DialogV2>
    )
  }
  return <button onClick={() => open("Lower")}>Open lower</button>
}

const scenario = new URLSearchParams(location.search).get("scenario")
function FocusScenario() {
  const dialogs = useDialog()
  const body = () => (
    <>
      <Show when={scenario !== "empty"}>
        <label>
          Scenario draft
          <input aria-label="Scenario draft" autofocus={scenario !== "default"} />
        </label>
        <button>Fallback control</button>
      </Show>
      <Show when={scenario === "popover"}>
        <Popover>
          <Popover.Trigger>Open popover</Popover.Trigger>
          <Popover.Portal>
            <Popover.Content data-kb-top-layer="" data-component="popover-content">
              <Popover.Title>Nested popover</Popover.Title>
              <label>
                Popover draft
                <input aria-label="Popover draft" />
              </label>
              <Popover.CloseButton aria-label="Close popover">Close popover</Popover.CloseButton>
            </Popover.Content>
          </Popover.Portal>
        </Popover>
      </Show>
      <Show when={scenario?.startsWith("nested-")}>
        <NestedControls kind={scenario!.slice("nested-".length)} />
      </Show>
      <Show when={scenario === "empty"}>
        <p>No interactive children</p>
      </Show>
    </>
  )
  const panel = () =>
    scenario === "legacy" ? (
      <Dialog title="Scenario">{body()}</Dialog>
    ) : (
      <DialogV2>
        <DialogHeader hideClose={scenario === "empty"}>
          <DialogTitle>Scenario</DialogTitle>
        </DialogHeader>
        <DialogBody>{body()}</DialogBody>
      </DialogV2>
    )
  return <button onClick={() => dialogs.show(bindDialog(panel, "scenario"))}>Open scenario</button>
}

render(
  () => (
    <>
      <h1>Dialog lifecycle acceptance</h1>
      <button data-testid="outside">Outside control</button>
      <Show when={scenario?.startsWith("standalone-")}>
        <NestedControls kind={scenario!.slice("standalone-".length)} />
      </Show>
      <output data-testid="closed">{JSON.stringify(state.closed)}</output>
      <output data-testid="disposed">{JSON.stringify(state.disposed)}</output>
      <Show when={state.mounted}>
        <DialogProvider>
          <Show when={scenario} fallback={<Launcher />}>
            <FocusScenario />
          </Show>
        </DialogProvider>
      </Show>
    </>
  ),
  document.getElementById("root")!,
)
