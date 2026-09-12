import { BrowserWindow, dialog, net } from "electron"
import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import { createMainWindow, openExternalURL, updateTitlebar } from "./windows"
import { nativeT } from "./native-translations"
import { KODA_VERSION, KODA_RELEASE_URL, newerKodaRelease } from "./koda-release"

export type DesktopMenuActionHandlers = Partial<{
  checkForUpdates: () => void
  relaunch: () => void
}>

export function runDesktopMenuAction(
  win: BrowserWindow | null,
  action: DesktopMenuAction,
  handlers: DesktopMenuActionHandlers = {},
) {
  switch (action) {
    case "app.checkForUpdates":
      void checkKodaUpdate()
      return
    case "app.about":
      void dialog.showMessageBox({
        type: "info",
        title: nativeT("desktop.menu.about"),
        message: nativeT("desktop.about.title", { version: KODA_VERSION }),
        detail: nativeT("desktop.about.detail"),
      })
      return
    case "app.relaunch":
      handlers.relaunch?.()
      return
    case "window.new":
      createMainWindow()
      return
    case "window.close":
      win?.close()
      return
    case "window.minimize":
      win?.minimize()
      return
    case "window.toggleMaximize":
      if (win?.isMaximized()) {
        win.unmaximize()
        return
      }
      win?.maximize()
      return
    case "view.reload":
      win?.reload()
      return
    case "view.toggleDevTools":
      win?.webContents.toggleDevTools()
      return
    case "view.resetZoom":
      setZoom(win, 1)
      return
    case "view.zoomIn":
      setZoom(win, (win?.webContents.getZoomFactor() ?? 1) + 0.2)
      return
    case "view.zoomOut":
      setZoom(win, (win?.webContents.getZoomFactor() ?? 1) - 0.2)
      return
    case "view.toggleFullscreen":
      win?.setFullScreen(!win.isFullScreen())
      return
    case "edit.undo":
      win?.webContents.undo()
      return
    case "edit.redo":
      win?.webContents.redo()
      return
    case "edit.cut":
      win?.webContents.cut()
      return
    case "edit.copy":
      win?.webContents.copy()
      return
    case "edit.paste":
      win?.webContents.paste()
      return
    case "edit.delete":
      win?.webContents.delete()
      return
    case "edit.selectAll":
      win?.webContents.selectAll()
      return
  }
}

let checking = false

async function checkKodaUpdate() {
  if (checking) return
  checking = true
  try {
    const response = await net.fetch("https://api.github.com/repos/zh2100/koda-opencode/releases/tags/Koda", {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const version = newerKodaRelease(await response.json())
    if (!version) {
      await dialog.showMessageBox({ type: "info", message: nativeT("desktop.updater.dialog.upToDate.message") })
      return
    }
    const result = await dialog.showMessageBox({
      type: "info",
      message: nativeT("desktop.koda.update.available", { version }),
      buttons: [nativeT("desktop.koda.update.open"), nativeT("desktop.updater.dialog.later")],
      defaultId: 0,
      cancelId: 1,
    })
    if (result.response === 0) openExternalURL(KODA_RELEASE_URL)
  } catch {
    await dialog.showMessageBox({ type: "error", message: nativeT("desktop.updater.dialog.checkFailed.message") })
  } finally {
    checking = false
  }
}

function setZoom(win: BrowserWindow | null, value: number) {
  if (!win) return
  win.webContents.setZoomFactor(Math.min(Math.max(value, 0.2), 10))
  updateTitlebar(win)
}
