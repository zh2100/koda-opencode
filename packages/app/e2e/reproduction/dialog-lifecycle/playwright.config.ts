import { defineConfig, devices } from "@playwright/test"
import { fileURLToPath } from "node:url"

const root = process.env.OPENCODE_ACCEPTANCE_ROOT
const port = Number(process.env.OPENCODE_ACCEPTANCE_PORT)
if (!root || !Number.isInteger(port) || port <= 0) throw new Error("An isolated acceptance root and port are required")
const baseURL = "http://127.0.0.1:" + port
const output = root.replaceAll("\\", "/")
process.env.PLAYWRIGHT_PORT = String(port)
process.env.PLAYWRIGHT_SERVER_PORT = String(port)
process.env.PLAYWRIGHT_BASE_URL = baseURL

export default defineConfig({
  testDir: "../../regression",
  testMatch: [
    "dialog-nested-layers.spec.ts",
    "mcp-source-edit.spec.ts",
    "dialog-lifecycle-acceptance.spec.ts",
    "mcp-dialog-acceptance.spec.ts",
  ],
  outputDir: output + "/browser-results",
  timeout: 90000,
  expect: { timeout: 15000 },
  workers: 1,
  retries: 0,
  reporter: [
    ["line"],
    ["json", { outputFile: output + "/playwright-results.json" }],
    ["html", { outputFolder: output + "/html-report", open: "never" }],
  ],
  webServer: {
    command:
      'bun run build -- --config e2e/reproduction/dialog-lifecycle/vite.config.ts --outDir "' +
      output +
      '/dist" && bun run serve -- --host 127.0.0.1 --port ' +
      port +
      ' --strictPort --outDir "' +
      output +
      '/dist"',
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    url: baseURL,
    reuseExistingServer: false,
    timeout: 300000,
    env: { VITE_OPENCODE_SERVER_HOST: "127.0.0.1", VITE_OPENCODE_SERVER_PORT: String(port) },
  },
  use: { baseURL, locale: "en-US", trace: "on", screenshot: "on", video: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
})
