import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { spawnSync } from "node:child_process"
import { reserve, audit } from "./a3-evidence.mjs"

test("a second candidate cannot start in a reserved checkout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "a3-active-"))
  try {
    const script = path.join(root, "script", "a3-evidence.mjs")
    fs.mkdirSync(path.dirname(script))
    fs.copyFileSync(new URL("./a3-evidence.mjs", import.meta.url), script)
    const lock = path.join(root, ".a3-evidence-active.json")
    fs.writeFileSync(lock, "first candidate")
    const candidate = path.join(root, "second")
    const result = spawnSync(process.execPath, [script, "run", candidate], { encoding: "utf8" })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /EEXIST/)
    assert.equal(fs.existsSync(candidate), false)
    assert.equal(fs.readFileSync(lock, "utf8"), "first candidate")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("archive reservation refuses an existing directory without changing it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "a3-archive-"))
  try {
    const directory = path.join(root, "candidate")
    reserve(directory)
    fs.writeFileSync(path.join(directory, "marker"), "original")
    assert.throws(() => reserve(directory), { code: "EEXIST" })
    assert.equal(fs.readFileSync(path.join(directory, "marker"), "utf8"), "original")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("archive audit rejects missing artifacts, changed artifacts and source drift", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "a3-audit-"))
  const hash = (text) => crypto.createHash("sha256").update(text).digest("hex")
  const manifest = { sources: {}, artifacts: { "gate.log": hash("passed") }, required: ["gate.log"] }
  const write = () => fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest))
  try {
    fs.writeFileSync(path.join(root, "gate.log"), "passed")
    write()
    audit(root)
    fs.writeFileSync(path.join(root, "gate.log"), "changed")
    assert.throws(() => audit(root), /artifact mismatch/)
    fs.unlinkSync(path.join(root, "gate.log"))
    assert.throws(() => audit(root), /ENOENT/)
    manifest.artifacts = {}
    write()
    assert.throws(() => audit(root), /missing required artifact/)
    manifest.sources = { "script/a3-evidence.mjs": "wrong" }
    write()
    assert.throws(() => audit(root), /source drift/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
