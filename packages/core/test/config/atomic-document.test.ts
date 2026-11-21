import { createHash } from "node:crypto"
import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import { AtomicDocument } from "../../src/config/atomic-document"

function digest(text: string) {
  return createHash("sha256").update(text).digest("hex")
}

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-atomic-"))
  return {
    dir,
    file: path.join(dir, "config.json"),
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

async function isolated(script: string) {
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

const moduleURL = () => pathToFileURL(path.resolve(import.meta.dir, "../../src/config/atomic-document.ts")).href

test("publishes complete documents on create and replace, with one receipt each", async () => {
  await using tmp = await fixture()
  let receipts = 0
  const onCommitted = () => {
    receipts++
  }
  expect(await AtomicDocument.publish({ file: tmp.file, before: undefined, text: "old", onCommitted })).toEqual({
    committed: true,
    cleanupPending: false,
  })
  expect(await AtomicDocument.publish({ file: tmp.file, before: "old", text: "new", onCommitted })).toEqual({
    committed: true,
    cleanupPending: false,
  })
  expect(await fs.readFile(tmp.file, "utf8")).toBe("new")
  expect(receipts).toBe(2)
  expect(await fs.readdir(tmp.dir)).toEqual(["config.json"])
})

for (const mode of ["create", "replace", "publishCopy"] as const) {
  test(`CL-09 ${mode} committed stage failure retries cleanup without republishing`, async () => {
    await using tmp = await fixture()
    if (mode !== "create") await fs.writeFile(tmp.file, "old")
    const destination = mode === "publishCopy" ? tmp.file + ".bak" : tmp.file
    const rmdir = spyOn(fs, "rmdir").mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }))
    const open = fs.open.bind(fs)
    let preparations = 0
    const intercepted = spyOn(fs, "open").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("document.tmp")) preparations++
      return open(...args)
    })
    try {
      const result =
        mode === "publishCopy"
          ? await AtomicDocument.publishCopy(tmp.file, destination, "new")
          : await AtomicDocument.publish({
              file: destination,
              before: mode === "replace" ? "old" : undefined,
              text: "new",
            })
      expect(result).toEqual({ committed: true, cleanupPending: true })
      expect(preparations).toBe(1)
      const committed = await fs.stat(destination)
      expect(await fs.readFile(destination, "utf8")).toBe("new")
      expect((await fs.readdir(tmp.dir)).some((name) => name.startsWith(".opencode-stage-"))).toBe(true)
      expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 0, failed: 0 })
      expect(preparations).toBe(1)
      expect((await fs.stat(destination)).ino).toBe(committed.ino)
      expect(await fs.readFile(destination, "utf8")).toBe("new")
      expect((await fs.readdir(tmp.dir)).some((name) => name.startsWith(".opencode-stage-"))).toBe(false)
      if (mode === "publishCopy") {
        expect(await fs.readFile(tmp.file, "utf8")).toBe("old")
        await expect(AtomicDocument.publishCopy(tmp.file, destination, "replacement")).rejects.toMatchObject({
          stage: "prepare",
        })
        expect(preparations).toBe(1)
        expect(await fs.readFile(destination, "utf8")).toBe("new")
      }
    } finally {
      intercepted.mockRestore()
      rmdir.mockRestore()
      await AtomicDocument.retryCleanup()
    }
  })
}

test("CL-09 retire permission failure retains responsibility and retries only the captured version", async () => {
  await using tmp = await fixture()
  await fs.writeFile(tmp.file, "legacy")
  const stat = await fs.stat(tmp.file)
  const intercepted = spyOn(fs, "unlink").mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }))
  const publish = spyOn(AtomicDocument, "publish")
  try {
    await expect(AtomicDocument.retire(tmp.file, { dev: stat.dev, ino: stat.ino, digest: digest("legacy") })).rejects.toMatchObject({
      code: "EACCES",
    })
    expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 1, failed: 1 })
    expect(await fs.readFile(tmp.file, "utf8")).toBe("legacy")
    expect((await fs.stat(tmp.file)).ino).toBe(stat.ino)
    expect(publish).not.toHaveBeenCalled()
    intercepted.mockRestore()
    expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 0, failed: 0 })
    expect(
      await fs.stat(tmp.file).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    expect(publish).not.toHaveBeenCalled()
  } finally {
    intercepted.mockRestore()
    publish.mockRestore()
    await AtomicDocument.retryCleanup()
  }
})

test("CL-09 retire refuses changed bytes on the same captured inode", async () => {
  await using tmp = await fixture()
  const child = await isolated(`
    const fs = (await import("node:fs/promises")).default;
    const { createHash } = await import("node:crypto");
    const { AtomicDocument } = await import(${JSON.stringify(moduleURL())});
    const file = ${JSON.stringify(tmp.file)};
    await fs.writeFile(file, "legacy");
    const owner = await fs.stat(file);
    const digest = createHash("sha256").update("legacy").digest("hex");
    await fs.writeFile(file, "changed");
    if ((await fs.stat(file)).ino !== owner.ino) throw new Error("fixture replaced inode");
    let rejected = false;
    try { await AtomicDocument.retire(file, { dev: owner.dev, ino: owner.ino, digest }) }
    catch (error) { rejected = error.message === "Retired document version changed" }
    const cleanup = await AtomicDocument.retryCleanup();
    if (!rejected || cleanup.remaining !== 1 || cleanup.failed !== 1 || await fs.readFile(file, "utf8") !== "changed") {
      throw new Error(JSON.stringify({ rejected, cleanup }));
    }
    console.log("CL09_RETIRE_VERSION_RETAINED");
  `)
  expect(child.code).toBe(0)
  expect(child.stderr).toBe("")
  expect(child.stdout).toContain("CL09_RETIRE_VERSION_RETAINED")
})

test("CL-09 publishCopy never overwrites a destination created during preparation", async () => {
  await using tmp = await fixture()
  await fs.writeFile(tmp.file, "source")
  const destination = tmp.file + ".bak"
  const link = fs.link.bind(fs)
  const intercepted = spyOn(fs, "link").mockImplementation(async (from, to) => {
    await fs.writeFile(destination, "competitor", { flag: "wx" })
    return link(from, to)
  })
  try {
    await expect(AtomicDocument.publishCopy(tmp.file, destination, "ours")).rejects.toMatchObject({ stage: "prepare" })
    expect(intercepted).toHaveBeenCalledTimes(1)
    expect(await fs.readFile(destination, "utf8")).toBe("competitor")
    expect(await fs.readFile(tmp.file, "utf8")).toBe("source")
    expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 0, failed: 0 })
    expect((await fs.readdir(tmp.dir)).some((name) => name.startsWith(".opencode-stage-"))).toBe(false)
  } finally {
    intercepted.mockRestore()
  }
})

test("version checks distinguish a literal replacement character from invalid UTF-8", async () => {
  await using tmp = await fixture()
  const bytes = Buffer.from([0xff])
  await fs.writeFile(tmp.file, bytes)
  await expect(AtomicDocument.publish({ file: tmp.file, before: "\uFFFD", text: "new" })).rejects.toMatchObject({ stage: "prepare" })
  expect(await fs.readFile(tmp.file)).toEqual(bytes)
})

test("version conflicts leave bytes and target identity unchanged", async () => {
  await using tmp = await fixture()
  await fs.writeFile(tmp.file, "actual")
  const before = await fs.stat(tmp.file)
  await expect(AtomicDocument.publish({ file: tmp.file, before: "stale", text: "new" })).rejects.toBeDefined()
  expect(await fs.readFile(tmp.file, "utf8")).toBe("actual")
  expect((await fs.stat(tmp.file)).ino).toBe(before.ino)
})

for (const before of [undefined, "old"]) {
  for (const code of ["EIO", "ENOSPC"]) {
    test(`${before === undefined ? "create" : "replace"} keeps the previous state after a partial ${code} write`, async () => {
      await using tmp = await fixture()
      if (before !== undefined) await fs.writeFile(tmp.file, before)
      const original = before === undefined ? undefined : await fs.stat(tmp.file)
      const open = fs.open.bind(fs)
      const intercepted = spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args)
        const write = handle.writeFile.bind(handle)
        handle.writeFile = async () => {
          await write("partial", "utf8")
          throw Object.assign(new Error("controlled write failure"), { code })
        }
        return handle
      })
      let committed = 0
      try {
        await expect(
          AtomicDocument.publish({
            file: tmp.file,
            before,
            text: "complete",
            onCommitted: () => {
              committed++
            },
          }),
        ).rejects.toMatchObject({ stage: "prepare", cause: { code } })
      } finally {
        intercepted.mockRestore()
      }
      expect(committed).toBe(0)
      if (original) {
        expect(await fs.readFile(tmp.file, "utf8")).toBe(before!)
        expect((await fs.stat(tmp.file)).ino).toBe(original.ino)
      } else
        expect(
          await fs.stat(tmp.file).then(
            () => true,
            () => false,
          ),
        ).toBe(false)
      expect(await fs.readdir(tmp.dir)).toEqual(before === undefined ? [] : ["config.json"])
      expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 0, failed: 0 })
    })
  }
}

test.skipIf(process.platform !== "win32")(
  "F1-06 Windows DACL preparation failure closes the owned handle before any document byte",
  async () => {
    for (const before of [undefined, "old"] as const) {
      await using tmp = await fixture()
      if (before !== undefined) await fs.writeFile(tmp.file, before)
      const original = before === undefined ? undefined : await fs.stat(tmp.file)
      const missing = path.join(tmp.dir, "missing-security-source")
      const open = fs.open.bind(fs)
      const unlink = fs.unlink.bind(fs)
      const rmdir = fs.rmdir.bind(fs)
      const order: string[] = []
      let writes = 0
      let committed = 0
      let owned: fs.FileHandle | undefined
      let restoreClose: fs.FileHandle["close"] | undefined
      let restoreWrite: fs.FileHandle["writeFile"] | undefined
      const interceptedOpen = spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args)
        if (!String(args[0]).endsWith("document.tmp")) return handle
        owned = handle
        restoreClose = handle.close
        restoreWrite = handle.writeFile
        const write = handle.writeFile.bind(handle)
        const close = handle.close.bind(handle)
        handle.writeFile = async (...input) => {
          writes++
          return write(...input)
        }
        handle.close = async () => {
          const closed = close()
          order.push("close-pending")
          await closed
          order.push("close")
        }
        return handle
      })
      const interceptedUnlink = spyOn(fs, "unlink").mockImplementation(async (file, ...args) => {
        if (String(file).endsWith(".tmp")) {
          if (!order.includes("close")) order.push("unlink-before-close")
          order.push("unlink")
        }
        return unlink(file, ...args)
      })
      const interceptedRmdir = spyOn(fs, "rmdir").mockImplementation(async (dir, ...args) => {
        if (String(dir).includes(".opencode-stage-")) {
          if (!order.includes("close")) order.push("rmdir-before-close")
          order.push("rmdir")
        }
        return rmdir(dir, ...args)
      })
      let caught: unknown
      try {
        await AtomicDocument.publish({
          file: tmp.file,
          before,
          text: "complete",
          securitySource: missing,
          onCommitted: () => {
            committed++
          },
        })
      } catch (error) {
        caught = error
      } finally {
        if (owned && restoreClose) owned.close = restoreClose
        if (owned && restoreWrite) owned.writeFile = restoreWrite
        interceptedOpen.mockRestore()
        interceptedUnlink.mockRestore()
        interceptedRmdir.mockRestore()
      }
      expect(caught).toMatchObject({ stage: "prepare" })
      const cause = caught instanceof Error ? caught.cause : undefined
      const rendered = `${cause instanceof Error ? cause.message : ""} ${cause && typeof cause === "object" && "stderr" in cause ? String(cause.stderr) : ""}`
      expect(rendered).toContain("GetAccessControl")
      expect(rendered).toContain("FileNotFoundException")
      expect(rendered).toContain("missing-security-source")
      expect(writes).toBe(0)
      expect(committed).toBe(0)
      expect(order).toEqual(["close-pending", "close", "unlink", "rmdir"])
      if (original && before !== undefined) {
        expect(await fs.readFile(tmp.file, "utf8")).toBe(before)
        expect((await fs.stat(tmp.file)).ino).toBe(original.ino)
        expect(await fs.readdir(tmp.dir)).toEqual(["config.json"])
      } else expect(await fs.readdir(tmp.dir)).toEqual([])
      expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 0, failed: 0 })
    }
  },
)

test.skipIf(process.platform !== "win32")(
  "F1-06 Windows DACL preparation failure keeps prepare primary when cleanup fails",
  async () => {
    await using tmp = await fixture()
    await fs.writeFile(tmp.file, "old")
    const original = await fs.stat(tmp.file)
    const missing = path.join(tmp.dir, "missing-security-source")
    let committed = 0
    const rmdir = spyOn(fs, "rmdir").mockRejectedValue(
      Object.assign(new Error("controlled cleanup failure"), { code: "EBUSY" }),
    )
    let caught: unknown
    try {
      await AtomicDocument.publish({
        file: tmp.file,
        before: "old",
        text: "complete",
        securitySource: missing,
        onCommitted: () => {
          committed++
        },
      })
    } catch (error) {
      caught = error
    }
    const cause = caught instanceof Error ? caught.cause : undefined
    const rendered = `${cause instanceof Error ? cause.message : ""} ${cause && typeof cause === "object" && "stderr" in cause ? String(cause.stderr) : ""}`
    expect(caught).toMatchObject({ stage: "prepare" })
    expect(rendered).toContain("GetAccessControl")
    expect(rendered).not.toContain("controlled cleanup failure")
    expect(committed).toBe(0)
    expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 1, failed: 1 })
    expect((await fs.readdir(tmp.dir)).some((entry) => entry.startsWith(".opencode-stage-"))).toBe(true)
    rmdir.mockRestore()
    expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 0, failed: 0 })
    expect(committed).toBe(0)
    expect(await fs.readFile(tmp.file, "utf8")).toBe("old")
    expect((await fs.stat(tmp.file)).ino).toBe(original.ino)
    expect(await fs.readdir(tmp.dir)).toEqual(["config.json"])
  },
)

test.skipIf(process.platform !== "win32")(
  "F1-06 Windows DACL preparation plus close rejection stays uncertain and does not clean up",
  async () => {
    await using tmp = await fixture()
    await fs.writeFile(tmp.file, "old-secret")
    const child = await isolated(`
    const fs = (await import("node:fs/promises")).default;
    const path = (await import("node:path")).default;
    const { AtomicDocument } = await import(${JSON.stringify(moduleURL())});
    const file = ${JSON.stringify(tmp.file)};
    const missing = path.join(path.dirname(file), "missing-security-source");
    const open = fs.open.bind(fs), unlink = fs.unlink.bind(fs);
    let closes = 0, unlinks = 0;
    fs.open = async (...args) => {
      const handle = await open(...args);
      handle.close = async () => { closes++; throw Object.assign(new Error("secret-close"), { code: "EIO" }) };
      return handle;
    };
    fs.unlink = async (...args) => { unlinks++; return unlink(...args) };
    let stage = "success", rendered = "";
    try { await AtomicDocument.publish({ file, before: "old-secret", text: "complete", securitySource: missing }) }
    catch (error) { stage = error && error.stage; rendered = JSON.stringify(error && error.cause) }
    const cleanup = await AtomicDocument.retryCleanup();
    const names = await fs.readdir(path.dirname(file), { recursive: true });
    const kept = names.some((entry) => String(entry).endsWith("document.tmp"));
    if (stage !== "prepare" || closes !== 1 || unlinks !== 0 || !kept || cleanup.remaining < 1 || cleanup.failed < 1) {
      throw new Error(JSON.stringify({ stage, closes, unlinks, kept, cleanup }));
    }
    if (rendered.includes("secret-close") || await fs.readFile(file, "utf8") !== "old-secret") throw new Error(rendered);
    console.log("F1_06_DACL_CLOSE_UNCERTAIN");
  `)
    expect(child.stderr).toBe("")
    expect(child.code).toBe(0)
    expect(child.stdout).toContain("F1_06_DACL_CLOSE_UNCERTAIN")
  },
)

test("F1-06 write failure closes the owned handle before identity cleanup", async () => {
  await using tmp = await fixture()
  await fs.writeFile(tmp.file, "old")
  const original = await fs.stat(tmp.file)
  const open = fs.open.bind(fs)
  const unlink = fs.unlink.bind(fs)
  const rmdir = fs.rmdir.bind(fs)
  const order: string[] = []
  let owned: fs.FileHandle | undefined
  let restoreClose: fs.FileHandle["close"] | undefined
  const interceptedOpen = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (!String(args[0]).endsWith("document.tmp")) return handle
    owned = handle
    restoreClose = handle.close
    const write = handle.writeFile.bind(handle)
    const close = handle.close.bind(handle)
    handle.writeFile = async () => {
      await write("partial", "utf8")
      throw Object.assign(new Error("controlled write failure"), { code: "EACCES" })
    }
    handle.close = async () => {
      order.push("close-start")
      const closed = close()
      order.push("close-pending")
      await closed
      order.push("close")
    }
    return handle
  })
  const interceptedUnlink = spyOn(fs, "unlink").mockImplementation(async (file, ...args) => {
    if (String(file).endsWith(".tmp")) order.push("unlink")
    return unlink(file, ...args)
  })
  const interceptedRmdir = spyOn(fs, "rmdir").mockImplementation(async (dir, ...args) => {
    if (String(dir).includes(".opencode-stage-")) order.push("rmdir")
    return rmdir(dir, ...args)
  })
  try {
    await expect(AtomicDocument.publish({ file: tmp.file, before: "old", text: "complete" })).rejects.toMatchObject({
      stage: "prepare",
      cause: { code: "EACCES" },
    })
  } finally {
    if (owned && restoreClose) owned.close = restoreClose
    interceptedOpen.mockRestore()
    interceptedUnlink.mockRestore()
    interceptedRmdir.mockRestore()
  }
  expect(order).toEqual(["close-start", "close-pending", "close", "unlink", "rmdir"])
  expect(await fs.readFile(tmp.file, "utf8")).toBe("old")
  expect((await fs.stat(tmp.file)).ino).toBe(original.ino)
  expect(await fs.readdir(tmp.dir)).toEqual(["config.json"])
  expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 0, failed: 0 })
})

test("temporary readback failure never publishes unverified bytes", async () => {
  await using tmp = await fixture()
  await fs.writeFile(tmp.file, "old")
  const read = fs.readFile.bind(fs)
  const intercepted = spyOn(fs, "readFile").mockImplementation(((
    file: Parameters<typeof fs.readFile>[0],
    ...args: unknown[]
  ) =>
    String(file).endsWith(".tmp")
      ? Promise.resolve(Buffer.from("corrupt"))
      : Reflect.apply(read, fs, [file, ...args])) as typeof fs.readFile)
  try {
    await expect(AtomicDocument.publish({ file: tmp.file, before: "old", text: "new" })).rejects.toMatchObject({
      stage: "prepare",
    })
  } finally {
    intercepted.mockRestore()
  }
  expect(await fs.readFile(tmp.file, "utf8")).toBe("old")
  expect(await fs.readdir(tmp.dir)).toEqual(["config.json"])
})

test("a lost publication acknowledgement is confirmed once without replay", async () => {
  await using tmp = await fixture()
  const link = fs.link.bind(fs)
  let receipts = 0
  const intercepted = spyOn(fs, "link").mockImplementation(async (...args) => {
    await link(...args)
    throw new Error("lost acknowledgement after publication")
  })
  try {
    expect(
      await AtomicDocument.publish({
        file: tmp.file,
        before: undefined,
        text: "published",
        onCommitted: () => {
          receipts++
        },
      }),
    ).toEqual({ committed: true, cleanupPending: false })
    expect(intercepted).toHaveBeenCalledTimes(1)
  } finally {
    intercepted.mockRestore()
  }
  expect(receipts).toBe(1)
  expect(await fs.readFile(tmp.file, "utf8")).toBe("published")
  expect(await fs.readdir(tmp.dir)).toEqual(["config.json"])
})

test("a competing first creator is never overwritten", async () => {
  await using tmp = await fixture()
  const original = fs.link.bind(fs)
  const link = spyOn(fs, "link").mockImplementation(async (from, to) => {
    await fs.writeFile(tmp.file, "competitor", { flag: "wx" })
    return original(from, to)
  })
  try {
    await expect(AtomicDocument.publish({ file: tmp.file, before: undefined, text: "ours" })).rejects.toBeDefined()
    expect(await fs.readFile(tmp.file, "utf8")).toBe("competitor")
    expect(await fs.readdir(tmp.dir)).toEqual(["config.json"])
  } finally {
    link.mockRestore()
  }
})

test("hardlinked and read-only targets fail without modifying either name", async () => {
  await using tmp = await fixture()
  await fs.writeFile(tmp.file, "old")
  const alias = path.join(tmp.dir, "alias")
  await fs.link(tmp.file, alias)
  await expect(AtomicDocument.publish({ file: tmp.file, before: "old", text: "new" })).rejects.toBeDefined()
  expect(await fs.readFile(alias, "utf8")).toBe("old")
  await fs.unlink(alias)
  await fs.chmod(tmp.file, 0o444)
  try {
    await expect(AtomicDocument.publish({ file: tmp.file, before: "old", text: "new" })).rejects.toBeDefined()
    expect(await fs.readFile(tmp.file, "utf8")).toBe("old")
  } finally {
    await fs.chmod(tmp.file, 0o666)
  }
})

test("junction aliases replace the original target without creating an alias copy", async () => {
  await using tmp = await fixture()
  const actual = path.join(tmp.dir, "actual")
  const alias = path.join(tmp.dir, "alias")
  await fs.mkdir(actual)
  await fs.symlink(actual, alias, process.platform === "win32" ? "junction" : "dir")
  await fs.writeFile(path.join(actual, "config.json"), "old")
  await AtomicDocument.publish({ file: path.join(alias, "config.json"), before: "old", text: "new" })
  expect(await fs.readFile(path.join(actual, "config.json"), "utf8")).toBe("new")
  expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true)
})

test("receipt observer failure cannot turn a committed save into a failure", async () => {
  await using tmp = await fixture()
  expect(
    (
      await AtomicDocument.publish({
        file: tmp.file,
        before: undefined,
        text: "new",
        onCommitted: () => {
          throw new Error("observer")
        },
      })
    ).committed,
  ).toBe(true)
  expect(await fs.readFile(tmp.file, "utf8")).toBe("new")
})

test.skipIf(process.platform !== "win32")(
  "Windows create installs a protected current-user DACL before document bytes",
  async () => {
    await using tmp = await fixture()
    const run = (script: string, file = tmp.file) =>
      execFileSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
          windowsHide: true,
          encoding: "utf8",
          env: { ...process.env, OPENCODE_ACL_FIXTURE: file },
        },
      ).trim()
    const open = fs.open.bind(fs)
    let prepared = ""
    const intercepted = spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args)
      const write = handle.writeFile.bind(handle)
      handle.writeFile = async (...input) => {
        prepared = run(
          "$ErrorActionPreference='Stop'; $a=[System.IO.File]::GetAccessControl($env:OPENCODE_ACL_FIXTURE); if (-not $a.AreAccessRulesProtected) { throw 'inheritance still enabled' }; $a.GetSecurityDescriptorSddlForm('Access')",
          String(args[0]),
        )
        return write(...input)
      }
      return handle
    })
    try {
      await AtomicDocument.publish({ file: tmp.file, before: undefined, text: "secret" })
    } finally {
      intercepted.mockRestore()
    }
    expect(prepared).toContain("D:P")
    const published = run(
      "$ErrorActionPreference='Stop'; [System.IO.File]::GetAccessControl($env:OPENCODE_ACL_FIXTURE).GetSecurityDescriptorSddlForm('Access')",
    )
    expect(published).toContain("D:P")
    expect(await fs.readFile(tmp.file, "utf8")).toBe("secret")
    expect((await fs.readdir(tmp.dir)).some((entry) => entry.startsWith(".opencode-stage-"))).toBe(false)
  },
)

test.skipIf(process.platform !== "win32")(
  "Windows backup copy preserves the source DACL before its first byte",
  async () => {
    await using tmp = await fixture()
    await fs.writeFile(tmp.file, "old-secret")
    const run = (script: string, file = tmp.file) =>
      execFileSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
          windowsHide: true,
          encoding: "utf8",
          env: { ...process.env, OPENCODE_ACL_FIXTURE: file },
        },
      ).trim()
    const source = run(
      "$ErrorActionPreference='Stop'; $a=[System.IO.File]::GetAccessControl($env:OPENCODE_ACL_FIXTURE); $a.SetAccessRuleProtection($true,$false); $s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $r=[System.Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','Allow'); $a.SetAccessRule($r); [System.IO.File]::SetAccessControl($env:OPENCODE_ACL_FIXTURE,$a); [System.IO.File]::GetAccessControl($env:OPENCODE_ACL_FIXTURE).GetSecurityDescriptorSddlForm('Access, Owner, Group')",
    )
    const backup = tmp.file + ".bak"
    const open = fs.open.bind(fs)
    let prepared = ""
    const intercepted = spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args)
      const write = handle.writeFile.bind(handle)
      handle.writeFile = async (...input) => {
        prepared = run(
          "[System.IO.File]::GetAccessControl($env:OPENCODE_ACL_FIXTURE).GetSecurityDescriptorSddlForm('Access, Owner, Group')",
          String(args[0]),
        )
        return write(...input)
      }
      return handle
    })
    try {
      await AtomicDocument.publishCopy(tmp.file, backup, "old-secret")
    } finally {
      intercepted.mockRestore()
    }
    expect(prepared).toBe(source)
    expect(
      run(
        "[System.IO.File]::GetAccessControl($env:OPENCODE_ACL_FIXTURE).GetSecurityDescriptorSddlForm('Access, Owner, Group')",
        backup,
      ),
    ).toBe(source)
  },
)

test.skipIf(process.platform !== "win32")("Windows replacement preserves an explicit protected DACL", async () => {
  await using tmp = await fixture()
  await fs.writeFile(tmp.file, "old")
  const run = (script: string, file = tmp.file) =>
    execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        encoding: "utf8",
        env: { ...process.env, OPENCODE_ACL_FIXTURE: file },
      },
    ).trim()
  const before = run(
    "$ErrorActionPreference='Stop'; $a=[System.IO.File]::GetAccessControl($env:OPENCODE_ACL_FIXTURE); $a.SetAccessRuleProtection($true,$false); $s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $r=[System.Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','Allow'); $a.SetAccessRule($r); [System.IO.File]::SetAccessControl($env:OPENCODE_ACL_FIXTURE,$a); [System.IO.File]::GetAccessControl($env:OPENCODE_ACL_FIXTURE).GetSecurityDescriptorSddlForm('All')",
  )
  const open = fs.open.bind(fs)
  let preparedAcl = ""
  const intercepted = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args)
    const write = handle.writeFile.bind(handle)
    handle.writeFile = async (...input) => {
      preparedAcl = run(
        "[System.IO.File]::GetAccessControl($env:OPENCODE_ACL_FIXTURE).GetSecurityDescriptorSddlForm('All')",
        String(args[0]),
      )
      return write(...input)
    }
    return handle
  })
  try {
    await AtomicDocument.publish({ file: tmp.file, before: "old", text: "new" })
  } finally {
    intercepted.mockRestore()
  }
  expect(preparedAcl).toBe(before)
  expect(
    run("[System.IO.File]::GetAccessControl($env:OPENCODE_ACL_FIXTURE).GetSecurityDescriptorSddlForm('All')"),
  ).toBe(before)
  expect(await fs.readFile(tmp.file, "utf8")).toBe("new")
})

test.skipIf(process.platform === "win32")("POSIX replacement preserves owner, group and restricted mode", async () => {
  await using tmp = await fixture()
  await fs.writeFile(tmp.file, "old", { mode: 0o640 })
  const before = await fs.stat(tmp.file)
  await AtomicDocument.publish({ file: tmp.file, before: "old", text: "new" })
  const after = await fs.stat(tmp.file)
  expect(after.uid).toBe(before.uid)
  expect(after.gid).toBe(before.gid)
  expect(after.mode & 0o777).toBe(0o640)
  expect(await fs.readFile(tmp.file, "utf8")).toBe("new")
})

test("CL-01 committed publication keeps success when stage removal fails once", async () => {
  await using tmp = await fixture()
  const rmdir = fs.rmdir.bind(fs)
  const intercepted = spyOn(fs, "rmdir").mockImplementationOnce(async () => {
    throw Object.assign(new Error("busy"), { code: "EBUSY" })
  })
  try {
    expect(await AtomicDocument.publish({ file: tmp.file, before: undefined, text: "new" })).toEqual({
      committed: true,
      cleanupPending: true,
    })
  } finally {
    intercepted.mockRestore()
  }
  expect(await fs.readFile(tmp.file, "utf8")).toBe("new")
  expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 0, failed: 0 })
  expect(await fs.readdir(tmp.dir)).toEqual(["config.json"])
  expect(rmdir).toBeDefined()
})

test("CL-02 committed publication keeps the directory responsibility while removal keeps failing", async () => {
  await using tmp = await fixture()
  const rmdir = fs.rmdir.bind(fs)
  const intercepted = spyOn(fs, "rmdir").mockImplementation(async () => {
    throw Object.assign(new Error("busy"), { code: "EBUSY" })
  })
  try {
    expect(await AtomicDocument.publish({ file: tmp.file, before: undefined, text: "new" })).toEqual({
      committed: true,
      cleanupPending: true,
    })
    expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 1, failed: 1 })
    expect(await fs.readFile(tmp.file, "utf8")).toBe("new")
  } finally {
    intercepted.mockRestore()
  }
  expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 0, failed: 0 })
  expect(await fs.readdir(tmp.dir)).toEqual(["config.json"])
  expect(rmdir).toBeDefined()
})

test("cleanup failure after create retains commit and retries only the owned temporary file", async () => {
  await using tmp = await fixture()
  const unlink = spyOn(fs, "unlink").mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }))
  try {
    expect(await AtomicDocument.publish({ file: tmp.file, before: undefined, text: "new" })).toEqual({
      committed: true,
      cleanupPending: true,
    })
  } finally {
    unlink.mockRestore()
  }
  expect(await fs.readFile(tmp.file, "utf8")).toBe("new")
  expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 0, failed: 0 })
  expect(await fs.readdir(tmp.dir)).toEqual(["config.json"])
})

test("failed initial handle inspection closes the descriptor and cleans only its own temporary file", async () => {
  await using tmp = await fixture()
  await fs.writeFile(tmp.file, "old")
  const open = fs.open.bind(fs)
  let closed = false
  const intercepted = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args)
    const close = handle.close.bind(handle)
    const stat = handle.stat.bind(handle)
    let first = true
    handle.stat = ((...options: Parameters<typeof handle.stat>) => {
      if (!first) return stat(...options)
      first = false
      return Promise.reject(new Error("inspection failed"))
    }) as typeof handle.stat
    handle.close = async () => {
      closed = true
      await close()
    }
    return handle
  })
  try {
    await expect(AtomicDocument.publish({ file: tmp.file, before: "old", text: "new" })).rejects.toBeDefined()
  } finally {
    intercepted.mockRestore()
  }
  expect(closed).toBe(true)
  expect(await fs.readFile(tmp.file, "utf8")).toBe("old")
  expect(await fs.readdir(tmp.dir)).toEqual(["config.json"])
})

test("a later save cleans an owned create temporary before checking hardlinks", async () => {
  await using tmp = await fixture()
  const unlink = spyOn(fs, "unlink").mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }))
  try {
    expect((await AtomicDocument.publish({ file: tmp.file, before: undefined, text: "first" })).cleanupPending).toBe(
      true,
    )
  } finally {
    unlink.mockRestore()
  }
  expect((await AtomicDocument.publish({ file: tmp.file, before: "first", text: "second" })).committed).toBe(true)
  expect(await fs.readFile(tmp.file, "utf8")).toBe("second")
  expect(await fs.readdir(tmp.dir)).toEqual(["config.json"])
})

test("F1-07 cleanup and a second publication cannot retire a temporary still being written", async () => {
  await using tmp = await fixture()
  const ready = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const open = fs.open.bind(fs)
  let first = true
  let closes = 0
  let owned: fs.FileHandle | undefined
  let restoreClose: fs.FileHandle["close"] | undefined
  let restoreWrite: fs.FileHandle["writeFile"] | undefined
  const intercepted = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (!first) return handle
    first = false
    owned = handle
    restoreClose = handle.close
    restoreWrite = handle.writeFile
    const write = handle.writeFile.bind(handle)
    const close = handle.close.bind(handle)
    handle.writeFile = async (...input) => {
      ready.resolve()
      await proceed.promise
      return write(...input)
    }
    handle.close = async () => {
      closes++
      return close()
    }
    return handle
  })
  const publishing = AtomicDocument.publish({ file: tmp.file, before: undefined, text: "first" })
  void publishing.catch(() => undefined)
  try {
    await ready.promise
    await AtomicDocument.retryCleanup()
    expect(closes).toBe(0)
    expect(
      (await fs.readdir(tmp.dir, { recursive: true })).filter((file) => String(file).endsWith(".tmp")),
    ).toHaveLength(1)
    const other = path.join(tmp.dir, "other.json")
    expect((await AtomicDocument.publish({ file: other, before: undefined, text: "second" })).committed).toBe(true)
    expect(closes).toBe(0)
    expect(
      (await fs.readdir(tmp.dir, { recursive: true })).filter((file) => String(file).endsWith(".tmp")),
    ).toHaveLength(1)
    proceed.resolve()
    expect((await publishing).committed).toBe(true)
    expect(await fs.readFile(tmp.file, "utf8")).toBe("first")
    expect(await fs.readFile(other, "utf8")).toBe("second")
    expect(closes).toBe(1)
    expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 0, failed: 0 })
  } finally {
    proceed.resolve()
    await publishing.catch(() => undefined)
    if (owned && restoreClose) owned.close = restoreClose
    if (owned && restoreWrite) owned.writeFile = restoreWrite
    intercepted.mockRestore()
  }
})

test("CL-05 open failure after stage creation is not left permanently active", async () => {
  await using tmp = await fixture()
  await fs.writeFile(tmp.file, "old")
  const open = fs.open.bind(fs)
  const intercepted = spyOn(fs, "open").mockImplementation(async (...args) => {
    if (String(args[0]).endsWith("document.tmp")) throw Object.assign(new Error("denied"), { code: "EACCES" })
    return open(...args)
  })
  try {
    await expect(AtomicDocument.publish({ file: tmp.file, before: "old", text: "new" })).rejects.toMatchObject({
      stage: "prepare",
      cause: { code: "EACCES" },
    })
  } finally {
    intercepted.mockRestore()
  }
  expect(await fs.readFile(tmp.file, "utf8")).toBe("old")
  expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 0, failed: 0 })
  expect(await fs.readdir(tmp.dir)).toEqual(["config.json"])
})

test("CL-05 directory removal stays pending until the injected failure is restored", async () => {
  await using tmp = await fixture()
  const open = fs.open.bind(fs)
  const rmdir = spyOn(fs, "rmdir").mockImplementation(async () => {
    throw Object.assign(new Error("busy"), { code: "EBUSY" })
  })
  const intercepted = spyOn(fs, "open").mockImplementation(async (...args) => {
    if (String(args[0]).endsWith("document.tmp")) throw Object.assign(new Error("denied"), { code: "EACCES" })
    return open(...args)
  })
  try {
    await expect(AtomicDocument.publish({ file: tmp.file, before: undefined, text: "new" })).rejects.toMatchObject({
      stage: "prepare",
    })
    expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 1, failed: 1 })
    expect((await fs.readdir(tmp.dir)).some((entry) => entry.startsWith(".opencode-stage-"))).toBe(true)
  } finally {
    intercepted.mockRestore()
    rmdir.mockRestore()
  }
  expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 0, failed: 0 })
  expect(await fs.readdir(tmp.dir)).toEqual([])
})

test("CL-07 and F2-04 immediate cleanup and retryCleanup unlink and remove the stage once", async () => {
  await using tmp = await fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const unlink = fs.unlink.bind(fs)
  const rmdir = fs.rmdir.bind(fs)
  let calls = 0
  let rmdirs = 0
  let concurrent: Promise<{ remaining: number; failed: number }> | undefined
  const intercepted = spyOn(fs, "unlink").mockImplementation(async (file, ...args) => {
    if (!String(file).endsWith(".tmp")) return unlink(file, ...args)
    calls++
    entered.resolve()
    await release.promise
    return unlink(file, ...args)
  })
  const interceptedRmdir = spyOn(fs, "rmdir").mockImplementation(async (dir, ...args) => {
    if (String(dir).includes(".opencode-stage-")) rmdirs++
    return rmdir(dir, ...args)
  })
  const publishing = AtomicDocument.publish({ file: tmp.file, before: undefined, text: "once" })
  try {
    await entered.promise
    let skipped = false
    concurrent = AtomicDocument.retryCleanup().then((counts) => {
      skipped = true
      return counts
    })
    await Promise.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    expect(skipped).toBe(true)
    expect(calls).toBe(1)
    expect(rmdirs).toBe(0)
    release.resolve()
    expect((await publishing).committed).toBe(true)
    await concurrent
  } finally {
    release.resolve()
    await publishing.catch(() => undefined)
    await concurrent
    intercepted.mockRestore()
    interceptedRmdir.mockRestore()
  }
  expect(calls).toBe(1)
  expect(rmdirs).toBe(1)
  expect(await fs.readFile(tmp.file, "utf8")).toBe("once")
  expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 0, failed: 0 })
})

test("F2-05 prepare cleanup and a concurrent retryCleanup do not reenter", async () => {
  await using tmp = await fixture()
  await fs.writeFile(tmp.file, "old")
  const original = await fs.stat(tmp.file)
  const open = fs.open.bind(fs)
  const unlink = fs.unlink.bind(fs)
  const rmdir = fs.rmdir.bind(fs)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let unlinks = 0
  let rmdirs = 0
  let owned: fs.FileHandle | undefined
  let restoreClose: fs.FileHandle["close"] | undefined
  let restoreWrite: fs.FileHandle["writeFile"] | undefined
  let concurrent: Promise<{ remaining: number; failed: number }> | undefined
  const interceptedOpen = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (!String(args[0]).endsWith("document.tmp")) return handle
    owned = handle
    restoreClose = handle.close
    restoreWrite = handle.writeFile
    const write = handle.writeFile.bind(handle)
    handle.writeFile = async () => {
      await write("partial", "utf8")
      throw Object.assign(new Error("controlled write failure"), { code: "EACCES" })
    }
    return handle
  })
  const interceptedUnlink = spyOn(fs, "unlink").mockImplementation(async (file, ...args) => {
    if (!String(file).endsWith(".tmp")) return unlink(file, ...args)
    unlinks++
    entered.resolve()
    await release.promise
    return unlink(file, ...args)
  })
  const interceptedRmdir = spyOn(fs, "rmdir").mockImplementation(async (dir, ...args) => {
    if (String(dir).includes(".opencode-stage-")) rmdirs++
    return rmdir(dir, ...args)
  })
  const publishing = AtomicDocument.publish({ file: tmp.file, before: "old", text: "complete" })
  const observed = publishing.then(
    () => undefined,
    (error) => error,
  )
  try {
    await entered.promise
    let skipped = false
    concurrent = AtomicDocument.retryCleanup().then((counts) => {
      skipped = true
      return counts
    })
    await Promise.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    expect(skipped).toBe(true)
    expect(unlinks).toBe(1)
    expect(rmdirs).toBe(0)
    release.resolve()
    await concurrent
    expect(await observed).toMatchObject({ stage: "prepare", cause: { code: "EACCES" } })
  } finally {
    release.resolve()
    await publishing.catch(() => undefined)
    await concurrent
    if (owned && restoreClose) owned.close = restoreClose
    if (owned && restoreWrite) owned.writeFile = restoreWrite
    interceptedOpen.mockRestore()
    interceptedUnlink.mockRestore()
    interceptedRmdir.mockRestore()
  }
  expect(unlinks).toBe(1)
  expect(rmdirs).toBe(1)
  expect(await fs.readFile(tmp.file, "utf8")).toBe("old")
  expect((await fs.stat(tmp.file)).ino).toBe(original.ino)
  expect(await fs.readdir(tmp.dir)).toEqual(["config.json"])
  expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 0, failed: 0 })
})

test("CL-03 file cleanup failure keeps the directory until both responsibilities finish", async () => {
  await using tmp = await fixture()
  const unlink = spyOn(fs, "unlink").mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }))
  try {
    expect(await AtomicDocument.publish({ file: tmp.file, before: undefined, text: "kept" })).toEqual({
      committed: true,
      cleanupPending: true,
    })
  } finally {
    unlink.mockRestore()
  }
  const stages = (await fs.readdir(tmp.dir)).filter((entry) => entry.startsWith(".opencode-stage-"))
  expect(stages).toHaveLength(1)
  expect(await fs.readdir(path.join(tmp.dir, stages[0]))).toEqual(["document.tmp"])
  const rmdir = spyOn(fs, "rmdir").mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }))
  try {
    expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 1, failed: 1 })
  } finally {
    rmdir.mockRestore()
  }
  expect(await fs.readdir(path.join(tmp.dir, stages[0])).catch(() => [])).toEqual([])
  expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 0, failed: 0 })
  expect(await fs.readdir(tmp.dir)).toEqual(["config.json"])
})

test("CL-04 missing owned objects complete separately and leave no false responsibility", async () => {
  await using tmp = await fixture()
  const unlink = spyOn(fs, "unlink").mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }))
  try {
    expect((await AtomicDocument.publish({ file: tmp.file, before: undefined, text: "kept" })).cleanupPending).toBe(
      true,
    )
  } finally {
    unlink.mockRestore()
  }
  const stage = (await fs.readdir(tmp.dir)).find((entry) => entry.startsWith(".opencode-stage-"))
  expect(stage).toBeDefined()
  await fs.unlink(path.join(tmp.dir, stage!, "document.tmp"))
  const rmdir = spyOn(fs, "rmdir").mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }))
  try {
    expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 1, failed: 1 })
  } finally {
    rmdir.mockRestore()
  }
  await fs.rmdir(path.join(tmp.dir, stage!))
  expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 0, failed: 0 })
})

test("CL-06 a replaced or populated stage is retained and the successor is left intact", async () => {
  await using tmp = await fixture()
  const rmdir = spyOn(fs, "rmdir").mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }))
  try {
    expect((await AtomicDocument.publish({ file: tmp.file, before: undefined, text: "kept" })).cleanupPending).toBe(
      true,
    )
  } finally {
    rmdir.mockRestore()
  }
  const stage = (await fs.readdir(tmp.dir)).find((entry) => entry.startsWith(".opencode-stage-"))!
  await fs.writeFile(path.join(tmp.dir, stage, "stranger"), "keep")
  expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 1, failed: 1 })
  expect(await fs.readFile(path.join(tmp.dir, stage, "stranger"), "utf8")).toBe("keep")
  await fs.rm(path.join(tmp.dir, stage), { recursive: true, force: true })
  await fs.symlink(tmp.dir, path.join(tmp.dir, stage), process.platform === "win32" ? "junction" : "dir")
  expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 1, failed: 1 })
  expect((await fs.lstat(path.join(tmp.dir, stage))).isSymbolicLink()).toBe(true)
  await fs.unlink(path.join(tmp.dir, stage))
})

test("unknown publication retains its evidence and is never retried as an uncommitted write", async () => {
  await using tmp = await fixture()
  const module = pathToFileURL(path.resolve(import.meta.dir, "../../src/config/atomic-document.ts")).href
  const script = `
    const fs = (await import("node:fs/promises")).default;
    const path = (await import("node:path")).default;
    const { AtomicDocument } = await import(${JSON.stringify(module)});
    const file = ${JSON.stringify(tmp.file)};
    const stat = fs.stat.bind(fs), link = fs.link.bind(fs);
    let published = false;
    fs.link = async (...args) => { await link(...args); published = true; throw new Error("lost acknowledgement") };
    fs.stat = async (target, ...args) => {
      if (published && String(target) === file) throw Object.assign(new Error("cannot inspect publication"), { code: "EPERM" });
      return stat(target, ...args);
    };
    try { await AtomicDocument.publish({ file, before: undefined, text: "committed" }); throw new Error("unknown was accepted") }
    catch (error) { if (error.stage !== "unknown") throw error }
    fs.stat = stat; fs.link = link;
    const cleanup = await AtomicDocument.retryCleanup();
    if (cleanup.remaining !== 1 || cleanup.failed !== 1) throw new Error("unknown responsibility lost");
    if ((await fs.readdir(path.dirname(file))).length !== 2) throw new Error("evidence deleted");
    try { await AtomicDocument.publish({ file, before: "committed", text: "replayed" }); throw new Error("unknown replayed") }
    catch (error) { if (error.stage !== "unknown") throw error }
    if (await fs.readFile(file, "utf8") !== "committed") throw new Error("target changed");
    console.log("ACC_UNKNOWN_RETAINED");
  `
  const child = await isolated(script)
  expect(child.stderr).toBe("")
  expect(child.code).toBe(0)
  expect(child.stdout).toContain("ACC_UNKNOWN_RETAINED")
})

test("CL-05 persistent handle inspection failure closes the owned descriptor before publication settles", async () => {
  await using tmp = await fixture()
  const child = await isolated(`
    const fs = (await import("node:fs/promises")).default;
    const path = (await import("node:path")).default;
    const { AtomicDocument } = await import(${JSON.stringify(moduleURL())});
    const file = ${JSON.stringify(tmp.file)};
    const open = fs.open.bind(fs);
    let closes = 0, settled = false;
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    fs.open = async (...args) => {
      const handle = await open(...args);
      const close = handle.close.bind(handle);
      handle.stat = async () => { throw new Error("controlled persistent fstat failure") };
      handle.close = async () => { closes++; entered.resolve(); await release.promise; await close() };
      return handle;
    };
    const publishing = AtomicDocument.publish({ file, before: undefined, text: "safe-test" }).then(
      () => { settled = true; return "success" },
      (error) => { settled = true; return error && error.stage },
    );
    try {
      const gate = await Promise.race([entered.promise.then(() => "entered"), publishing.then(() => "settled", () => "settled")]);
      if (gate !== "entered" || closes !== 1) throw new Error("publish settled without closing the owned handle");
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (settled) throw new Error("publish settled before close finished");
      release.resolve();
      const result = await publishing;
      fs.open = open;
      const cleanup = await AtomicDocument.retryCleanup();
      const names = await fs.readdir(path.dirname(file), { recursive: true });
      const kept = names.some((entry) => String(entry).endsWith("document.tmp"));
      const target = await fs.stat(file).then(() => true, () => false);
      if (result !== "prepare" || !kept || target || cleanup.failed < 1 || cleanup.remaining < 1 || closes !== 1) {
        throw new Error(JSON.stringify({ result, kept, target, cleanup, closes }));
      }
      console.log("CL05_PERSISTENT_STAT_CLOSED");
    } finally {
      release.resolve();
      await publishing.catch(() => undefined);
    }
  `)
  expect(child.stderr).toBe("")
  expect(child.code).toBe(0)
  expect(child.stdout).toContain("CL05_PERSISTENT_STAT_CLOSED")
})

test("CL-05 close rejection keeps the known temporary file and does not retry the uncertain handle", async () => {
  await using tmp = await fixture()
  const child = await isolated(`
    const fs = (await import("node:fs/promises")).default;
    const path = (await import("node:path")).default;
    const { AtomicDocument } = await import(${JSON.stringify(moduleURL())});
    const file = ${JSON.stringify(tmp.file)};
    const open = fs.open.bind(fs), unlink = fs.unlink.bind(fs);
    let closes = 0, unlinks = 0;
    fs.open = async (...args) => {
      const handle = await open(...args);
      handle.close = async () => { closes++; throw Object.assign(new Error("controlled close failure"), { code: "EIO" }) };
      return handle;
    };
    fs.unlink = async (...args) => { unlinks++; return unlink(...args) };
    let stage = "success";
    try { await AtomicDocument.publish({ file, before: undefined, text: "safe-test" }) }
    catch (error) { stage = error && error.stage }
    const cleanup = await AtomicDocument.retryCleanup();
    const names = await fs.readdir(path.dirname(file), { recursive: true });
    const kept = names.some((entry) => String(entry).endsWith("document.tmp"));
    if (stage !== "prepare" || closes !== 1 || unlinks !== 0 || !kept || cleanup.failed < 1 || cleanup.remaining < 1) {
      throw new Error(JSON.stringify({ stage, closes, unlinks, kept, cleanup }));
    }
    console.log("CL05_CLOSE_REJECTED_ISOLATED");
  `)
  expect(child.stderr).toBe("")
  expect(child.code).toBe(0)
  expect(child.stdout).toContain("CL05_CLOSE_REJECTED_ISOLATED")
})

test("CL-07 duplicate retire waits and both callers observe the same cleanup failure", async () => {
  await using tmp = await fixture()
  await fs.writeFile(tmp.file, "legacy")
  const stat = await fs.stat(tmp.file)
  const owner = { dev: stat.dev, ino: stat.ino, digest: digest("legacy") }
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let unlinks = 0
  let firstSettled = false
  let secondSettled = false
  const unlink = fs.unlink.bind(fs)
  const intercepted = spyOn(fs, "unlink").mockImplementation(async (file, ...args) => {
    if (String(file) !== tmp.file) return unlink(file, ...args)
    unlinks++
    entered.resolve()
    await release.promise
    throw Object.assign(new Error("controlled unlink failure"), { code: "EBUSY" })
  })
  const first = AtomicDocument.retire(tmp.file, owner).then(
    () => {
      firstSettled = true
    },
    (error) => {
      firstSettled = true
      throw error
    },
  )
  const second = entered.promise
    .then(() => AtomicDocument.retire(tmp.file, owner))
    .then(
      () => {
        secondSettled = true
      },
      (error) => {
        secondSettled = true
        throw error
      },
    )
  try {
    await entered.promise
    await Promise.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(false)
    expect(unlinks).toBe(1)
    release.resolve()
    const [firstResult, secondResult] = await Promise.allSettled([first, second])
    expect(firstResult.status).toBe("rejected")
    expect(secondResult.status).toBe("rejected")
    if (firstResult.status === "rejected" && secondResult.status === "rejected") {
      expect(secondResult.reason).toBe(firstResult.reason)
      expect(firstResult.reason).toMatchObject({ code: "EBUSY" })
    }
    expect(await fs.readFile(tmp.file, "utf8")).toBe("legacy")
  } finally {
    release.resolve()
    await Promise.allSettled([first, second])
    intercepted.mockRestore()
    await AtomicDocument.retryCleanup()
  }
  expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 0, failed: 0 })
  expect(
    await fs.stat(tmp.file).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
})

test("F1-03 and F1-04 uncertain close is not recovered by retryCleanup or a later publication", async () => {
  await using tmp = await fixture()
  const child = await isolated(`
    const fs = (await import("node:fs/promises")).default;
    const path = (await import("node:path")).default;
    const { AtomicDocument } = await import(${JSON.stringify(moduleURL())});
    const file = ${JSON.stringify(tmp.file)};
    const other = path.join(path.dirname(file), "other.json");
    const open = fs.open.bind(fs);
    let closes = 0;
    fs.open = async (...args) => {
      const handle = await open(...args);
      handle.close = async () => { closes++; throw Object.assign(new Error("controlled close failure"), { code: "EIO" }) };
      return handle;
    };
    let stage = "success", cause;
    try { await AtomicDocument.publish({ file, before: undefined, text: "safe-test" }) }
    catch (error) { stage = error && error.stage; cause = error && error.cause }
    const blocked = await AtomicDocument.retryCleanup();
    const kept = (await fs.readdir(path.dirname(file), { recursive: true })).some((entry) => String(entry).endsWith("document.tmp"));
    if (stage !== "prepare" || closes !== 1 || !kept || blocked.remaining < 1 || blocked.failed < 1) throw new Error(JSON.stringify({ stage, closes, kept, blocked }));
    if (!cause || cause.cause?.code !== "EIO") throw new Error("primary close rejection was not retained");
    fs.open = async (...args) => open(...args);
    const [first, second] = await Promise.all([AtomicDocument.retryCleanup(), AtomicDocument.retryCleanup()]);
    let otherStage = "missing";
    try { await AtomicDocument.publish({ file: other, before: undefined, text: "independent" }); otherStage = "success" }
    catch (error) { otherStage = error && error.stage }
    const stillKept = (await fs.readdir(path.dirname(file), { recursive: true })).some((entry) => String(entry).endsWith("document.tmp"));
    if (closes !== 1 || !stillKept || first.remaining < 1 || second.remaining < 1 || otherStage !== "success" || await fs.readFile(other, "utf8") !== "independent") {
      throw new Error(JSON.stringify({ closes, stillKept, first, second, otherStage }));
    }
    console.log("F1_UNCERTAIN_NOT_RECOVERED");
  `)
  expect(child.stderr).toBe("")
  expect(child.code).toBe(0)
  expect(child.stdout).toContain("F1_UNCERTAIN_NOT_RECOVERED")
})

test("F1-08 a close wrapper rejection stays uncertain after the descriptor operation settled", async () => {
  await using tmp = await fixture()
  const child = await isolated(`
    const fs = (await import("node:fs/promises")).default;
    const path = (await import("node:path")).default;
    const { AtomicDocument } = await import(${JSON.stringify(moduleURL())});
    const file = ${JSON.stringify(tmp.file)};
    const open = fs.open.bind(fs);
    let closes = 0;
    fs.open = async (...args) => {
      const handle = await open(...args);
      const close = handle.close.bind(handle);
      handle.close = async () => { closes++; await close(); throw Object.assign(new Error("wrapper after close"), { code: "EIO" }) };
      return handle;
    };
    let stage = "success", cause;
    try { await AtomicDocument.publish({ file, before: undefined, text: "safe-test" }) }
    catch (error) { stage = error && error.stage; cause = error && error.cause }
    fs.open = open;
    const cleanup = await AtomicDocument.retryCleanup();
    const kept = (await fs.readdir(path.dirname(file), { recursive: true })).some((entry) => String(entry).endsWith("document.tmp"));
    if (stage !== "prepare" || closes !== 1 || !kept || cleanup.remaining < 1 || cause?.cause?.code !== "EIO") {
      throw new Error(JSON.stringify({ stage, closes, kept, cleanup, chained: cause?.cause?.code }));
    }
    console.log("F1_08_WRAPPER_UNCERTAIN");
  `)
  expect(child.stderr).toBe("")
  expect(child.code).toBe(0)
  expect(child.stdout).toContain("F1_08_WRAPPER_UNCERTAIN")
})

test("F1 prepare failure remains primary when close also rejects", async () => {
  await using tmp = await fixture()
  const child = await isolated(`
    const fs = (await import("node:fs/promises")).default;
    const { AtomicDocument } = await import(${JSON.stringify(moduleURL())});
    const file = ${JSON.stringify(tmp.file)};
    const open = fs.open.bind(fs);
    let closes = 0;
    fs.open = async (...args) => {
      const handle = await open(...args);
      handle.writeFile = async () => { throw Object.assign(new Error("controlled write failure"), { code: "ENOSPC" }) };
      handle.close = async () => { closes++; throw Object.assign(new Error("secret-close"), { code: "EIO" }) };
      return handle;
    };
    let stage = "success", cause;
    try { await AtomicDocument.publish({ file, before: undefined, text: "safe-test" }) }
    catch (error) { stage = error && error.stage; cause = error && error.cause }
    const rendered = JSON.stringify(cause);
    if (stage !== "prepare" || closes !== 1 || cause?.code !== "ENOSPC" || rendered.includes("secret-close")) {
      throw new Error(JSON.stringify({ stage, closes, code: cause?.code, rendered }));
    }
    console.log("F1_PREPARE_CAUSE_PRESERVED");
  `)
  expect(child.stderr).toBe("")
  expect(child.code).toBe(0)
  expect(child.stdout).toContain("F1_PREPARE_CAUSE_PRESERVED")
})

test("F2-01 duplicate retire waits and both callers observe one successful cleanup", async () => {
  await using tmp = await fixture()
  await fs.writeFile(tmp.file, "legacy")
  const stat = await fs.stat(tmp.file)
  const owner = { dev: stat.dev, ino: stat.ino, digest: digest("legacy") }
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let unlinks = 0
  let firstSettled = false
  let secondSettled = false
  const unlink = fs.unlink.bind(fs)
  const intercepted = spyOn(fs, "unlink").mockImplementation(async (file, ...args) => {
    if (String(file) !== tmp.file) return unlink(file, ...args)
    unlinks++
    entered.resolve()
    await release.promise
    return unlink(file, ...args)
  })
  const first = AtomicDocument.retire(tmp.file, owner).then(() => {
    firstSettled = true
  })
  const second = entered.promise
    .then(() => AtomicDocument.retire(tmp.file, owner))
    .then(() => {
      secondSettled = true
    })
  try {
    await entered.promise
    await new Promise((resolve) => setImmediate(resolve))
    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(false)
    expect(unlinks).toBe(1)
    release.resolve()
    await Promise.all([first, second])
    expect(
      await fs.stat(tmp.file).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  } finally {
    release.resolve()
    await Promise.allSettled([first, second])
    intercepted.mockRestore()
  }
  expect(unlinks).toBe(1)
  expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 0, failed: 0 })
})

test("F2-03 two retries after a rejected retire claim the cleanup once", async () => {
  await using tmp = await fixture()
  await fs.writeFile(tmp.file, "legacy")
  const stat = await fs.stat(tmp.file)
  const unlink = fs.unlink.bind(fs)
  let reject = true
  let unlinks = 0
  const intercepted = spyOn(fs, "unlink").mockImplementation(async (file, ...args) => {
    if (String(file) !== tmp.file) return unlink(file, ...args)
    unlinks++
    if (reject) throw Object.assign(new Error("controlled unlink failure"), { code: "EBUSY" })
    return unlink(file, ...args)
  })
  try {
    await expect(AtomicDocument.retire(tmp.file, { dev: stat.dev, ino: stat.ino, digest: digest("legacy") })).rejects.toMatchObject({
      code: "EBUSY",
    })
    expect(await fs.readFile(tmp.file, "utf8")).toBe("legacy")
    reject = false
    const before = unlinks
    await Promise.all([AtomicDocument.retryCleanup(), AtomicDocument.retryCleanup()])
    expect(unlinks - before).toBe(1)
  } finally {
    intercepted.mockRestore()
  }
  expect(
    await fs.stat(tmp.file).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 0, failed: 0 })
})

test("F2-06 a receipt retryCleanup skips the cleanup already claimed by publication", async () => {
  await using tmp = await fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let scans = 0
  let scanSettled = false
  const unlink = fs.unlink.bind(fs)
  const intercepted = spyOn(fs, "unlink").mockImplementation(async (file, ...args) => {
    if (!String(file).endsWith(".tmp")) return unlink(file, ...args)
    entered.resolve()
    await release.promise
    return unlink(file, ...args)
  })
  const publishing = AtomicDocument.publish({
    file: tmp.file,
    before: undefined,
    text: "once",
    onCommitted: () => {
      scans++
      void AtomicDocument.retryCleanup().then(() => {
        scanSettled = true
      })
    },
  })
  try {
    await entered.promise
    await new Promise((resolve) => setImmediate(resolve))
    expect(scans).toBe(1)
    expect(scanSettled).toBe(true)
    release.resolve()
    expect(await publishing).toEqual({ committed: true, cleanupPending: false })
  } finally {
    release.resolve()
    await publishing.catch(() => undefined)
    intercepted.mockRestore()
  }
  expect(scans).toBe(1)
  expect(await fs.readFile(tmp.file, "utf8")).toBe("once")
})

test("F2-07 a pending cleanup task does not block publication of another file", async () => {
  await using tmp = await fixture()
  await fs.writeFile(tmp.file, "legacy")
  const stat = await fs.stat(tmp.file)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const unlink = fs.unlink.bind(fs)
  const intercepted = spyOn(fs, "unlink").mockImplementation(async (file, ...args) => {
    if (String(file) !== tmp.file) return unlink(file, ...args)
    entered.resolve()
    await release.promise
    return unlink(file, ...args)
  })
  const retiring = AtomicDocument.retire(tmp.file, { dev: stat.dev, ino: stat.ino, digest: digest("legacy") })
  const other = path.join(tmp.dir, "other.json")
  try {
    await entered.promise
    expect(await AtomicDocument.publish({ file: other, before: undefined, text: "independent" })).toMatchObject({
      committed: true,
    })
    expect(await fs.readFile(other, "utf8")).toBe("independent")
    expect(await fs.readFile(tmp.file, "utf8")).toBe("legacy")
    release.resolve()
    await retiring
  } finally {
    release.resolve()
    await retiring.catch(() => undefined)
    intercepted.mockRestore()
  }
})

test("F2-08a completing one retire does not drop another identity record", async () => {
  await using tmp = await fixture()
  const first = path.join(tmp.dir, "first.json")
  const second = path.join(tmp.dir, "second.json")
  await fs.writeFile(first, "first")
  await fs.writeFile(second, "second")
  const firstStat = await fs.stat(first)
  const secondStat = await fs.stat(second)
  const entered = Promise.withResolvers<void>()
  const releaseFirst = Promise.withResolvers<void>()
  const releaseSecond = Promise.withResolvers<void>()
  let secondSettled = false
  const unlink = fs.unlink.bind(fs)
  const intercepted = spyOn(fs, "unlink").mockImplementation(async (file, ...args) => {
    if (String(file) === first) {
      entered.resolve()
      await releaseFirst.promise
    }
    if (String(file) === second) await releaseSecond.promise
    return unlink(file, ...args)
  })
  const retiringFirst = AtomicDocument.retire(first, { dev: firstStat.dev, ino: firstStat.ino, digest: digest("first") })
  const retiringSecond = AtomicDocument.retire(second, { dev: secondStat.dev, ino: secondStat.ino, digest: digest("second") }).then(() => {
    secondSettled = true
  })
  try {
    await entered.promise
    releaseFirst.resolve()
    await retiringFirst
    expect(secondSettled).toBe(false)
    expect(await fs.readFile(second, "utf8")).toBe("second")
    releaseSecond.resolve()
    await retiringSecond
    expect(
      await fs.stat(second).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  } finally {
    releaseFirst.resolve()
    releaseSecond.resolve()
    await Promise.allSettled([retiringFirst, retiringSecond])
    intercepted.mockRestore()
  }
})

test("retire rejects an unversioned removal before registering cleanup", async () => {
  await using tmp = await fixture()
  const child = await isolated(`
    const fs = (await import("node:fs/promises")).default;
    const { AtomicDocument } = await import(${JSON.stringify(moduleURL())});
    const file = ${JSON.stringify(tmp.file)};
    await fs.writeFile(file, "successor");
    const { dev, ino } = await fs.stat(file);
    for (const digest of [undefined, "", "invalid"]) {
      const error = await AtomicDocument.retire(file, { dev, ino, digest }).then(() => null, error => error);
      if (error?.message !== "Missing or invalid captured document digest") throw new Error("unversioned retire accepted");
    }
    const cleanup = await AtomicDocument.retryCleanup();
    if (cleanup.remaining || cleanup.failed || await fs.readFile(file, "utf8") !== "successor") throw new Error("unversioned cleanup");
  `)
  expect(child.stderr).toBe("")
  expect(child.code).toBe(0)
})

test("F2-08b and F2-09 a replaced temporary is not deleted and retire does not succeed", async () => {
  await using tmp = await fixture()
  const child = await isolated(`
    const fs = (await import("node:fs/promises")).default;
    const { AtomicDocument } = await import(${JSON.stringify(moduleURL())});
    const file = ${JSON.stringify(tmp.file)};
    await fs.writeFile(file, "old");
    const owner = await fs.stat(file);
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(await fs.readFile(file)).digest("hex");
    await fs.unlink(file);
    await fs.writeFile(file, "successor");
    const successor = await fs.stat(file);
    let failed = false;
    try { await AtomicDocument.retire(file, { dev: owner.dev, ino: owner.ino, digest }) }
    catch { failed = true }
    const cleanup = await AtomicDocument.retryCleanup();
    const remainingBytes = await fs.readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error });
    if (!failed || remainingBytes !== "successor" || cleanup.remaining < 1 || cleanup.failed < 1) {
      throw new Error(JSON.stringify({ failed, cleanup, oldIno: owner.ino, newIno: successor.ino, remainingBytes }));
    }
    console.log("F2_SUCCESSOR_RETAINED");
  `)
  expect(child.stderr).toBe("")
  expect(child.code).toBe(0)
  expect(child.stdout).toContain("F2_SUCCESSOR_RETAINED")
})
