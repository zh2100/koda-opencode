import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { Field } from "@opencode-ai/ui/v2/field-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useGlobal } from "@/context/global"
import { ServerConnection } from "@/context/server"
import { useDirectoryPicker } from "@/components/directory-picker"
import { joinProjectPath, projectNameInvalid } from "@/utils/project-path"

export function DialogCreateProject(props: {
  server: ServerConnection.Any
  onCreated: (directory: string) => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const platform = usePlatform()
  const pickDirectory = useDirectoryPicker()
  const global = useGlobal()
  const ctx = global.ensureServerCtx(props.server)
  const home = () => ctx.sync.data.path.home || ctx.sync.data.path.directory || ""
  const [store, setStore] = createStore({
    name: "",
    location: home(),
    error: undefined as string | undefined,
    pending: false,
  })
  const path = createMemo(() => {
    const name = store.name.trim()
    if (!name) return store.location
    return joinProjectPath(store.location || home(), name)
  })

  const browse = () => {
    pickDirectory({
      server: props.server,
      title: language.t("dialog.project.create.location"),
      onSelect: (result) => {
        const directory = Array.isArray(result) ? result[0] : result
        if (directory) setStore("location", directory)
      },
    })
  }

  const submit = async (event: Event) => {
    event.preventDefault()
    const invalid = projectNameInvalid(store.name)
    if (invalid === "name") {
      setStore("error", language.t("dialog.project.create.error.name"))
      return
    }
    if (invalid) {
      setStore("error", language.t("dialog.project.create.error.invalid"))
      return
    }
    const directory = path()
    setStore("pending", true)
    setStore("error", undefined)
    if (platform.platform === "desktop" && platform.mkdir) {
      const created = await platform.mkdir(directory).catch(() => undefined)
      if (!created) {
        setStore("pending", false)
        setStore("error", language.t("dialog.project.create.error.failed"))
        return
      }
    }
    const listed = await ctx.sdk.api.file
      .list({ path: ".", location: { directory } })
      .then((result) => result.data)
      .catch(() => undefined)
    if (listed && listed.length > 0) {
      setStore("pending", false)
      setStore("error", language.t("dialog.project.create.error.exists"))
      return
    }
    if (!listed) {
      setStore("pending", false)
      setStore("error", language.t("dialog.project.create.error.failed"))
      return
    }
    setStore("pending", false)
    props.onCreated(directory)
    dialog.close()
  }

  return (
    <Dialog fit>
      <form onSubmit={(event) => void submit(event)} class="contents">
        <DialogHeader>
          <DialogTitle>{language.t("dialog.project.create.title")}</DialogTitle>
        </DialogHeader>
        <DialogBody class="flex w-full flex-col gap-4 px-4 pt-4 pb-1">
          <Field>
            <Field.Label>{language.t("dialog.project.create.name")}</Field.Label>
            <TextInputV2
              autofocus
              appearance="large"
              class="!w-full"
              value={store.name}
              onInput={(event) => setStore("name", event.currentTarget.value)}
            />
          </Field>
          <Field>
            <Field.Label>{language.t("dialog.project.create.location")}</Field.Label>
            <div class="flex gap-2">
              <TextInputV2
                appearance="large"
                class="!w-full"
                value={store.location}
                onInput={(event) => setStore("location", event.currentTarget.value)}
              />
              <ButtonV2 type="button" variant="neutral" onClick={browse}>
                {language.t("dialog.project.create.browse")}
              </ButtonV2>
            </div>
          </Field>
          <p class="text-[13px] font-[440] leading-5 text-v2-text-text-muted">
            {language.t("dialog.project.create.path")}: <bdi dir="ltr">{path()}</bdi>
          </p>
          <Show when={store.error}>{(message) => <p class="text-[13px] text-v2-state-fg-danger">{message()}</p>}</Show>
        </DialogBody>
        <DialogFooter>
          <ButtonV2 type="button" variant="ghost-muted" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2 type="submit" variant="neutral" disabled={store.pending}>
            {language.t("dialog.project.create.submit")}
          </ButtonV2>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
