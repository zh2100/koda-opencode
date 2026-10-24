import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, existsSync } from "node:fs"
import { chmod, copyFile, mkdir, readdir, rename, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { app } from "electron"

const execFileAsync = promisify(execFile)
const root = dirname(fileURLToPath(import.meta.url))
const stateHome = process.env.XDG_STATE_HOME

type Logger = {
  log(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export async function startBackgroundCli(logger: Logger, shellStateHome?: string) {
  const bundled = app.isPackaged
    ? join(process.resourcesPath, executableName())
    : join(root, "../../resources", executableName())
  logger.log("v2 CLI executable resolved", { bundled, packaged: app.isPackaged })
  const version = await run(bundled, ["--version"], logger)
  const staged = app.isPackaged
    ? await installCli(bundled, version, logger)
    : { binary: bundled, directory: undefined, installed: false }
  const binary = staged.binary

  const candidates = [
    ...new Set([stateHome, shellStateHome, app.getPath("userData")]),
  ].filter((candidate): candidate is string => candidate !== undefined && existsSync(candidate))
  const daemonStateHome = stateHome ?? app.getPath("userData")

  // A newly staged binary replaces an older build, so any daemon already
  // registered from a previous install must be stopped before it is reused.
  if (staged.installed) {
    await Promise.all(
      candidates.map((candidate) =>
        run(binary, ["service", "stop"], logger, { stateHome: candidate }).catch(() => undefined),
      ),
    )
    await pruneStagedClis(staged.directory, logger)
  }

  const discovered = await Promise.all(
    candidates.map(async (candidate) => ({
      stateHome: candidate,
      url: serviceUrl(await run(binary, ["service", "status"], logger, { stateHome: candidate })),
    })),
  )
  const found = discovered.find((candidate) => candidate.url !== undefined)
  logger.log("v2 CLI background instance checked", {
    detected: Boolean(found),
    ...endpoint(found?.url),
  })

  const url = await run(binary, ["service", "start"], logger, {
    stateHome: found?.stateHome ?? daemonStateHome,
  })
  const password = await run(binary, ["service", "password"], logger, {
    redact: true,
    stateHome: found?.stateHome ?? daemonStateHome,
  })
  logger.log("v2 CLI background service ready", {
    existing: Boolean(found),
    username: "opencode",
    ...endpoint(url),
  })
  return {
    url,
    username: "opencode",
    password,
    stop: () => run(binary, ["service", "stop"], logger, { stateHome: found?.stateHome ?? daemonStateHome }).then(() => undefined),
  }
}

async function installCli(source: string, version: string, logger: Logger) {
  const fingerprint = await fileFingerprint(source)
  const directory = join(
    app.getPath("userData"),
    "cli",
    `${version.replace(/[^a-zA-Z0-9._-]/g, "-")}-${fingerprint.slice(0, 12)}`,
  )
  const destination = join(directory, executableName())
  if (existsSync(destination)) {
    logger.log("v2 CLI staged executable reused", { path: destination, version, fingerprint })
    return { binary: destination, directory, installed: false }
  }

  const temp = destination + `.${process.pid}.tmp`
  await mkdir(directory, { recursive: true })
  await copyFile(source, temp)
  if (process.platform !== "win32") await chmod(temp, 0o755)
  await rename(temp, destination).catch(async (error) => {
    await rm(temp, { force: true })
    throw error
  })
  logger.log("v2 CLI executable staged", { source, path: destination, version, fingerprint })
  return { binary: destination, directory, installed: true }
}

async function pruneStagedClis(directory: string | undefined, logger: Logger) {
  if (!directory) return
  const parent = dirname(directory)
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name !== basename(directory))
      .map((entry) =>
        rm(join(parent, entry.name), { recursive: true, force: true }).catch((error: unknown) => {
          logger.error("v2 CLI staged executable cleanup failed", {
            path: join(parent, entry.name),
            error: error instanceof Error ? error.message : String(error),
          })
        }),
      ),
  )
}

async function fileFingerprint(path: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

async function run(
  binary: string,
  args: string[],
  logger: Logger,
  options: { redact?: boolean; stateHome?: string } = {},
) {
  logger.log("v2 CLI command started", { binary, args })
  const env = { ...process.env }
  if (options.stateHome === undefined) delete env.XDG_STATE_HOME
  else env.XDG_STATE_HOME = options.stateHome
  return execFileAsync(binary, args, { env, windowsHide: true }).then(
    (result) => {
      const stdout = result.stdout.trim()
      const stderr = result.stderr.trim()
      logger.log("v2 CLI command completed", { args, stdout: options.redact ? "[redacted]" : stdout, stderr })
      return stdout
    },
    (error: unknown) => {
      const output = error as { stdout?: string; stderr?: string }
      logger.error("v2 CLI command failed", {
        args,
        error: error instanceof Error ? error.message : String(error),
        stdout: options.redact && output.stdout ? "[redacted]" : (output.stdout?.trim() ?? ""),
        stderr: output.stderr?.trim() ?? "",
      })
      throw error
    },
  )
}

function serviceUrl(status: string) {
  if (URL.canParse(status)) return status
  if (!status.startsWith("running ")) return
  const url = status.slice("running ".length).trim()
  return URL.canParse(url) ? url : undefined
}

function endpoint(url: string | undefined) {
  if (!url || !URL.canParse(url)) return {}
  const parsed = new URL(url)
  return { url, hostname: parsed.hostname, port: parsed.port }
}

function executableName() {
  return process.platform === "win32" ? "opencode-cli.exe" : "opencode-cli"
}
