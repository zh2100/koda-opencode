import path from "path"
import { describe, expect, test } from "bun:test"

describe("lock root migration", () => {
  test("plan does not enable apply and names an isolated target", async () => {
    const script = path.resolve(import.meta.dir, "../script/migrate-lock-root.ts")
    const source = path.join(import.meta.dir, "fixture-source")
    const planned = Bun.spawnSync(["bun", script, "plan", source])
    const refused = Bun.spawnSync(["bun", script, "apply", source])
    expect(planned.exitCode).toBe(0)
    expect(JSON.parse(planned.stdout.toString()).status).toBe("planned")
    expect(refused.exitCode).toBe(2)
  })
})
