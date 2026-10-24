import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import collaborationOff from "@/assets/prompt/collaboration-off.png"
import collaborationOn from "@/assets/prompt/collaboration-on.png"
import type { createPromptSubmit } from "./submit"

export function CollaborationToggle(props: { control: ReturnType<typeof createPromptSubmit>["collaboration"] }) {
  const language = useLanguage()
  const enabled = () => props.control.enabled()
  const label = () => language.t(enabled() ? "prompt.collaboration.on" : "prompt.collaboration.off")
  return (
    <TooltipV2 value={props.control.reason() || language.t("prompt.collaboration.description")}>
      <IconButtonV2
        type="button"
        data-action="prompt-collaboration"
        class="size-7"
        variant="ghost"
        aria-pressed={enabled()}
        aria-busy={props.control.state.busy}
        aria-label={label()}
        disabled={props.control.state.busy}
        icon={<img src={enabled() ? collaborationOn : collaborationOff} alt="" width={16} height={16} class="size-4" />}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          props.control.toggle()
        }}
      />
    </TooltipV2>
  )
}
