import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Select } from "@opencode-ai/ui/select"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Popover } from "@opencode-ai/ui/popover"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"

export function NestedControls(props: { kind: string }) {
  const [state, setState] = createStore({ selected: "Local" })
  return (
    <>
      <Show when={props.kind === "select"}>
        <Select
          options={["Local", "Remote"]}
          current={state.selected}
          onSelect={(value) => value && setState("selected", value)}
        />
      </Show>
      <Show when={props.kind === "select-v2"}>
        <SelectV2
          options={["Local", "Remote"]}
          current={state.selected}
          onSelect={(value) => value && setState("selected", value)}
        />
      </Show>
      <Show when={props.kind === "menu"}>
        <MenuV2>
          <MenuV2.Trigger>Open child</MenuV2.Trigger>
          <MenuV2.Portal>
            <MenuV2.Content style={{ "z-index": "70" }}>
              <MenuV2.Item onSelect={() => setState("selected", "Remote")}>Remote</MenuV2.Item>
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
      </Show>
      <Show when={props.kind === "popover" || props.kind === "popover-select"}>
        <Popover triggerAs="button" trigger="Open child" title="Child" style={{ "z-index": "70" }}>
          <label>
            Child draft
            <input aria-label="Child draft" />
          </label>
          <Show when={props.kind === "popover-select"}>
            <SelectV2
              options={["Local", "Remote"]}
              current={state.selected}
              onSelect={(value) => value && setState("selected", value)}
            />
          </Show>
        </Popover>
      </Show>
      <output data-testid="nested-selection">{state.selected}</output>
    </>
  )
}
