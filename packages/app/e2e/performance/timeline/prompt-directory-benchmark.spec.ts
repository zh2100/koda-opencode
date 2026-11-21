import { benchmark, expect, withBenchmarkPage } from "../benchmark"
import { fixture } from "./session-timeline-stress.fixture"
import { installTimelineSettings, mockStressTimeline, stressSessionHref } from "./timeline-test-helpers"
import { waitForStableTimeline } from "./session-tab-switch-probe"

// Measures production session/composer readiness without relying on persisted tab fixtures or SSE transport.
benchmark("opens a production session with its composer ready", async ({ browser, report }, testInfo) => {
  const elapsed: number[] = []
  for (let run = 0; run < 3; run++) {
    elapsed.push(
      await withBenchmarkPage(
        browser,
        "prompt-directory-" + run,
        async (page) => {
          await mockStressTimeline(page)
          await installTimelineSettings(page)
          const start = performance.now()
          await page.goto(stressSessionHref(fixture.sourceID))
          await waitForStableTimeline(page, fixture.expected.sourceMessageIDs.at(-1)!)
          await expect(page.locator('[data-component="prompt-input"]').first()).toBeVisible()
          return performance.now() - start
        },
        testInfo,
      ),
    )
  }
  report({ sessionAndComposerReadyMs: elapsed, medianMs: [...elapsed].sort((a, b) => a - b)[1] }, { trials: 3 })
})
