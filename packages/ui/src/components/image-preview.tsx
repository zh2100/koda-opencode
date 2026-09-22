import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { Show } from "solid-js"
import { useI18n } from "../context/i18n"
import { IconButton } from "./icon-button"

export interface ImagePreviewProps {
  src: string
  alt?: string
  mime?: string
}

export function isPdfPreview(mime?: string, src?: string, name?: string) {
  if (mime === "application/pdf") return true
  if (src?.startsWith("data:application/pdf")) return true
  return (name ?? "").toLowerCase().endsWith(".pdf")
}

export function ImagePreview(props: ImagePreviewProps) {
  const i18n = useI18n()
  const pdf = () => isPdfPreview(props.mime, props.src, props.alt)
  return (
    <div data-component="image-preview">
      <div data-slot="image-preview-container">
        <Kobalte.Content data-slot="image-preview-content" data-kind={pdf() ? "pdf" : "image"}>
          <div data-slot="image-preview-header">
            <Kobalte.CloseButton
              data-slot="image-preview-close"
              as={IconButton}
              icon="close"
              variant="ghost"
              aria-label={i18n.t("ui.common.close")}
            />
          </div>
          <div data-slot="image-preview-body" data-kind={pdf() ? "pdf" : "image"}>
            <Show
              when={pdf()}
              fallback={
                <img src={props.src} alt={props.alt ?? i18n.t("ui.imagePreview.alt")} data-slot="image-preview-image" />
              }
            >
              <iframe
                src={props.src}
                title={props.alt ?? i18n.t("ui.imagePreview.pdf")}
                data-slot="image-preview-pdf"
              />
            </Show>
          </div>
        </Kobalte.Content>
      </div>
    </div>
  )
}
