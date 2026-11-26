import { expect, test } from "bun:test"
import { shouldOpenDefaultProject } from "./onboarding-policy"

const empty = { builtin: true, initialUrl: "/", tabs: 0, projects: 0, recentlyClosed: 0 }

test("opens a default project for an empty built-in desktop", () => {
  expect(shouldOpenDefaultProject(empty)).toBe(true)
})

test("preserves restored state, explicit navigation, remote servers and intentional project closes", () => {
  for (const change of [
    { builtin: false },
    { initialUrl: "/project/session" },
    { tabs: 1 },
    { projects: 1 },
    { recentlyClosed: 1 },
  ])
    expect(shouldOpenDefaultProject({ ...empty, ...change })).toBe(false)
})
