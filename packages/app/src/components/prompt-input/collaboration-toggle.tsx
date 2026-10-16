import { Button } from "@opencode-ai/ui/button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import type { createPromptSubmit } from "./submit"

export function CollaborationToggle(props: { control: ReturnType<typeof createPromptSubmit>["collaboration"] }) {
  const language = useLanguage()
  return (
    <Tooltip value={props.control.reason() || language.t("prompt.collaboration.description")}>
      <span
        class="inline-flex min-w-0"
        tabIndex={props.control.reason() ? 0 : undefined}
        aria-label={props.control.reason() || undefined}
      >
        <Button
          type="button"
          data-action="prompt-collaboration"
          variant={props.control.state.enabled ? "secondary" : "ghost"}
          size="small"
          aria-pressed={props.control.state.enabled}
          aria-busy={props.control.state.busy}
          disabled={props.control.state.busy || (!props.control.state.enabled && !!props.control.reason())}
          onClick={props.control.toggle}
        >
          {language.t(props.control.state.busy ? "prompt.collaboration.starting" : "settings.tab.collaboration")}
        </Button>
      </span>
    </Tooltip>
  )
}
