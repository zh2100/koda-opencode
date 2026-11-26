import { existsSync, readdirSync } from "node:fs"
import { app } from "electron"
import { getStore } from "./store"
import { FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY, OLD_LAYOUT_ELIGIBLE_KEY } from "./store-keys"
import { write as writeLog } from "./logging"
import { hasExistingAppState } from "./install-state"
import { prepareDefaultProject } from "./default-project"

export function initializeOldLayoutEligibility(userDataPath: string) {
  const entries = existsSync(userDataPath) ? readdirSync(userDataPath, { withFileTypes: true }) : []
  const store = getStore()
  const current = store.get(OLD_LAYOUT_ELIGIBLE_KEY)
  if (typeof current === "boolean") return current

  const eligible = hasExistingAppState(entries)
  store.set(OLD_LAYOUT_ELIGIBLE_KEY, eligible)
  return eligible
}

export function isOldLayoutEligible() {
  return getStore().get(OLD_LAYOUT_ELIGIBLE_KEY) === true
}

export function isFirstLaunchOnboardingPending() {
  const pending = getStore().get(FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY) !== true
  writeLog("onboarding", "first launch onboarding pending checked", { pending })
  return pending
}

export async function finishFirstLaunchOnboarding(createDefaultProject: boolean) {
  if (!isFirstLaunchOnboardingPending()) {
    writeLog("onboarding", "first launch onboarding already completed")
    return null
  }

  const defaultProject = createDefaultProject ? await prepareDefaultProject(app.getPath("home")) : null

  getStore().set(FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY, true)
  writeLog("onboarding", "first launch onboarding completed", { createDefaultProject, defaultProject })
  return defaultProject
}
