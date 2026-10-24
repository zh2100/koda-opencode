import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import computerUseOff from "@/assets/prompt/computer-use-off.png"
import computerUseOn from "@/assets/prompt/computer-use-on.png"

export function ComputerUseToggle() {
  const language = useLanguage()
  const settings = useSettings()
  const enabled = () => settings.computerUse.enabled()
  const label = () => language.t(enabled() ? "prompt.computerUse.on" : "prompt.computerUse.off")
  return (
    <TooltipV2 value={language.t("prompt.computerUse.description")}>
      <IconButtonV2
        type="button"
        data-action="prompt-computer-use"
        class="size-7"
        variant="ghost"
        aria-pressed={enabled()}
        aria-label={label()}
        icon={<img src={enabled() ? computerUseOn : computerUseOff} alt="" width={16} height={16} class="size-4" />}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          settings.computerUse.setEnabled(!enabled())
        }}
      />
    </TooltipV2>
  )
}
