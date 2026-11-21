import { describe, expect, test } from "bun:test"
import { createUpdaterController, type UpdaterBackend, type UpdaterReadyRecord } from "./updater-controller"

function setup(input?: {
  currentVersion?: string
  ready?: UpdaterReadyRecord
  availableVersion?: string
  checkError?: string
  isUpdateAvailable?: boolean
  enabled?: boolean
}) {
  const calls: string[] = []
  const backend: UpdaterBackend = {
    async checkForUpdates() {
      calls.push("check")
      if (input?.checkError) throw new Error(input.checkError)
      return { isUpdateAvailable: input?.isUpdateAvailable ?? true, updateInfo: { version: input?.availableVersion ?? "2.0.0" } }
    },
    async downloadUpdate() {
      calls.push("download")
    },
    quitAndInstall() {
      calls.push("install")
    },
  }
  let ready = input?.ready
  const controller = createUpdaterController({
    enabled: input?.enabled ?? true,
    currentVersion: input?.currentVersion ?? "1.0.0",
    backend,
    persistence: {
      get: () => ready,
      set: (value) => {
        ready = value
      },
      clear: () => {
        ready = undefined
      },
    },
    stop: async () => {
      calls.push("stop")
    },
  })
  return { controller, calls, getReady: () => ready }
}

describe("updater controller", () => {
  test("checks, downloads, persists, and publishes one authoritative ready state", async () => {
    const app = setup()
    const states: ReturnType<typeof app.controller.getState>[] = []
    app.controller.subscribe((state) => states.push(state))

    await app.controller.start()

    expect(app.calls).toEqual(["check", "download"])
    expect(app.getReady()).toEqual({ version: "2.0.0" })
    expect(states.map((state) => state.status)).toEqual(["idle", "checking", "downloading", "ready"])
    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("revalidates a persisted target through the updater cache on launch", async () => {
    const app = setup({ ready: { version: "2.0.0" } })

    await app.controller.start()

    expect(app.calls).toEqual(["check", "download"])
    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("clears a target already installed before checking", async () => {
    const app = setup({ currentVersion: "2.0.0", ready: { version: "2.0.0" } })

    await app.controller.start()

    expect(app.getReady()).toBeUndefined()
    expect(app.calls).toEqual(["check"])
  })

  test("ignores an update feed that only contains an older version", async () => {
    const app = setup({ currentVersion: "1.0.6", availableVersion: "1.0.5", ready: { version: "1.0.5" } })

    await app.controller.start()

    expect(app.getReady()).toBeUndefined()
    expect(app.calls).toEqual(["check"])
    expect(app.controller.getState()).toEqual({ status: "up-to-date" })
    await expect(app.controller.install()).rejects.toThrow("Update is not ready to install")
    expect(app.calls).toEqual(["check"])
  })

  test.each([
    ["1.9.9", "2.0.0", true],
    ["1.9.9", "1.10.0", true],
    ["2.0.0", "1.99.99", false],
    ["1.10.0", "1.9.99", false],
    ["1.0.6", "1.0.6", false],
    ["1.0.6", "invalid", false],
    ["1.0.6", "1.0.6-beta.1", false],
    ["1.0.6", "1.0.6+build.2", false],
    ["1.0.6-beta.1", "1.0.6", true],
  ])("compares current %s with target %s numerically", async (currentVersion, availableVersion, newer) => {
    const app = setup({ currentVersion, availableVersion })

    await app.controller.start()

    expect(app.calls).toEqual(newer ? ["check", "download"] : ["check"])
    expect(app.controller.getState()).toEqual(
      newer ? { status: "ready", version: availableVersion } : { status: "up-to-date" },
    )
  })

  test("clears a stale downgrade record even when the update check fails", async () => {
    const app = setup({ currentVersion: "1.0.6", ready: { version: "1.0.5" }, checkError: "offline" })

    await app.controller.start()

    expect(app.getReady()).toBeUndefined()
    expect(app.controller.getState()).toEqual({ status: "error", message: "offline" })
    expect(app.calls).toEqual(["check"])
  })

  test("does not download when the GitHub provider reports no update", async () => {
    const app = setup({ currentVersion: "1.0.6", availableVersion: "1.0.7", isUpdateAvailable: false })

    await app.controller.check()

    expect(app.calls).toEqual(["check"])
    expect(app.controller.getState()).toEqual({ status: "up-to-date" })
    await expect(app.controller.install()).rejects.toThrow("Update is not ready to install")
  })

  test("keeps development and beta update checks disabled", async () => {
    const app = setup({ enabled: false, ready: { version: "2.0.0" } })

    await app.controller.start()
    await app.controller.check()

    expect(app.calls).toEqual([])
    expect(app.controller.getState()).toEqual({ status: "disabled" })
    await expect(app.controller.install()).rejects.toThrow("Update is not ready to install")
  })

  test("coalesces concurrent checks", async () => {
    const app = setup()

    await Promise.all([app.controller.check(), app.controller.check(), app.controller.check()])

    expect(app.calls).toEqual(["check", "download"])
  })

  test("returns to ready when quitAndInstall returns without exiting", async () => {
    const app = setup()
    await app.controller.start()

    await app.controller.install()

    expect(app.calls).toEqual(["check", "download", "stop", "install"])
    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("returns to ready when installation cannot start", async () => {
    const app = setup()
    await app.controller.start()

    const failed = createUpdaterController({
      enabled: true,
      currentVersion: "1.0.0",
      backend: {
        checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: "2.0.0" } }),
        downloadUpdate: async () => {},
        quitAndInstall() {},
      },
      persistence: { get: () => undefined, set() {}, clear() {} },
      stop: async () => {
        throw new Error("stop failed")
      },
    })
    await failed.start()

    await expect(failed.install()).rejects.toThrow("stop failed")
    expect(failed.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })
})
