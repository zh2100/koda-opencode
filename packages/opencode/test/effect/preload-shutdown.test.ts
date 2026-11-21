import { expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))

// Cold module loading is outside the product's 10-second shutdown budget.
// The parent owns each probe until exit, including on test cancellation.
const spawnProbe = (file: string) => Effect.acquireRelease(
  Effect.sync(() => Bun.spawn([process.execPath, "test", "--timeout", "120000", file], {
    cwd: path.resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe",
  })),
  (child) => Effect.promise(async () => {
    if (child.exitCode === null) child.kill()
    await child.exited
  }),
)

for (const incomplete of [false, true]) {
  it.live(`real preload ${incomplete ? "fails without deleting a still-owned root" : "deletes its root after actual shutdown"}`, () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const file = path.join(dir, "preload-probe.test.ts")
    const work = path.resolve(import.meta.dir, "../../src/effect/instance-work.ts")
    yield* Effect.promise(() => Bun.write(file, `
      import { test, expect } from "bun:test";
      import { InstanceWork } from ${JSON.stringify(work)};
      test("isolated shutdown probe", () => {
        ${incomplete ? 'InstanceWork.registerProducer({ directory: "shutdown-probe", worktree: "shutdown-probe", project: {} }, () => new Promise(() => {}));' : ""}
        expect(true).toBe(true);
      });
    `))
    const child = yield* spawnProbe(file)
    const childRoot = path.join(os.tmpdir(), `opencode-test-data-${child.pid}`)
    const [code, stderr] = yield* Effect.promise(() => Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]))
      .pipe(Effect.timeout("150 seconds"), Effect.map(([code, stderr]) => [code, stderr] as const))
    const exists = yield* Effect.promise(() => fs.stat(childRoot).then(() => true, () => false))
    try {
      expect(code === 0).toBe(!incomplete)
      expect(exists).toBe(incomplete)
      if (incomplete) expect(stderr).toContain("Runtime shutdown is incomplete")
    } finally {
      // The child has exited. Remove only its exact PID-scoped test root.
      if (path.dirname(childRoot) !== path.resolve(os.tmpdir()) || path.basename(childRoot) !== `opencode-test-data-${child.pid}`) throw new Error("Invalid child test root")
      yield* Effect.promise(() => fs.rm(childRoot, { recursive: true, force: true }))
    }
  }), 180000)
}

for (const permanent of [false, true]) {
  it.live(`real preload ${permanent ? "fails visibly after the EPERM budget" : "retries transient EPERM and confirms removal"}`, () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const file = path.join(dir, "cleanup-probe.test.ts")
    yield* Effect.promise(() => Bun.write(file, `
      import { test } from "bun:test";
      import fs from "node:fs/promises";
      import os from "node:os";
      import path from "node:path";
      const root = path.join(os.tmpdir(), "opencode-test-data-" + process.pid);
      const remove = fs.rm.bind(fs);
      let attempts = 0;
      test("controlled cleanup failure", () => {
        fs.rm = async (target, options) => {
          if (String(target) === root && (++attempts <= ${permanent ? 30 : 2})) {
            throw Object.assign(new Error("controlled sharing refusal"), { code: "EPERM", syscall: "unlink", path: path.join(root, "held-file") });
          }
          return remove(target, options);
        };
      });
    `))
    const child = yield* spawnProbe(file)
    const childRoot = path.join(os.tmpdir(), `opencode-test-data-${child.pid}`)
    const [code, stderr] = yield* Effect.promise(() => Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()])).pipe(Effect.timeout("150 seconds"))
    try {
      expect(code === 0).toBe(!permanent)
      expect(yield* Effect.promise(() => fs.stat(childRoot).then(() => true, () => false))).toBe(permanent)
      expect(stderr).toContain("test root cleanup failed")
      expect(stderr).toContain("held-file")
      if (permanent) expect(stderr).toContain("attempts: 30")
    } finally {
      if (path.dirname(childRoot) !== path.resolve(os.tmpdir()) || path.basename(childRoot) !== `opencode-test-data-${child.pid}`) throw new Error("Invalid child test root")
      yield* Effect.promise(() => fs.rm(childRoot, { recursive: true, force: true }))
    }
  }), 180000)
}
