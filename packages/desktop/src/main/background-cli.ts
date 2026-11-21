import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { app } from "electron"
import { commandEnv, servicePasswordCommand } from "./background-cli-compat"
import { retainLiveDirectories, stageCli } from "./cli-staging"

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
  const password = await readServicePassword(binary, logger, found?.stateHome ?? daemonStateHome)
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

async function readServicePassword(binary: string, logger: Logger, stateHome: string) {
  const help = await run(binary, ["service", "--help"], logger, { stateHome, redact: true })
  const args = servicePasswordCommand(help)
  if (!args) throw new Error("Bundled CLI does not expose a service password command")
  return run(binary, args, logger, { redact: true, stateHome })
}

async function installCli(source: string, version: string, logger: Logger) {
  return stageCli({
    source,
    stagingRoot: join(app.getPath("userData"), "cli"),
    version,
    native: {
      required: process.env.OPENCODE_NATIVE_LOCK_REQUIRED === "1",
      platform: process.env.OPENCODE_TARGET_PLATFORM ?? process.platform,
      arch: process.env.OPENCODE_TARGET_ARCH ?? process.arch,
    },
    logger,
    executableName: executableName(),
  })
}

async function pruneStagedClis(directory: string | undefined, logger: Logger) {
  if (!directory) return
  await retainLiveDirectories(dirname(directory), [directory], logger)
}

async function run(
  binary: string,
  args: string[],
  logger: Logger,
  options: { redact?: boolean; stateHome?: string } = {},
) {
  logger.log("v2 CLI command started", { binary, args })
  const env = commandEnv(binary, options.stateHome)
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
