import type { Argv } from "yargs"
import { RunCommand } from "./cmd/run"
import { GenerateCommand } from "./cmd/generate"
import { ConsoleCommand } from "./cmd/account"
import { ProvidersCommand } from "./cmd/providers"
import { AgentCommand } from "./cmd/agent"
import { UpgradeCommand } from "./cmd/upgrade"
import { UninstallCommand } from "./cmd/uninstall"
import { ModelsCommand } from "./cmd/models"
import { ServeCommand } from "./cmd/serve"
import { DebugCommand } from "./cmd/debug"
import { StatsCommand } from "./cmd/stats"
import { McpCommand } from "./cmd/mcp"
import { GithubCommand } from "./cmd/github"
import { ExportCommand } from "./cmd/export"
import { ImportCommand } from "./cmd/import"
import { AttachCommand } from "./cmd/attach"
import { TuiThreadCommand } from "./cmd/tui"
import { WebCommand } from "./cmd/web"
import { PrCommand } from "./cmd/pr"
import { SessionCommand } from "./cmd/session"
import { DbCommand } from "./cmd/db"
import { PluginCommand } from "./cmd/plug"

export function registerCommands<T>(cli: Argv<T>) {
  return cli
    .command(McpCommand)
    .command(TuiThreadCommand)
    .command(AttachCommand)
    .command(RunCommand)
    .command(GenerateCommand)
    .command(DebugCommand)
    .command(ConsoleCommand)
    .command(ProvidersCommand)
    .command(AgentCommand)
    .command(UpgradeCommand)
    .command(UninstallCommand)
    .command(ServeCommand)
    .command(WebCommand)
    .command(ModelsCommand)
    .command(StatsCommand)
    .command(ExportCommand)
    .command(ImportCommand)
    .command(GithubCommand)
    .command(PrCommand)
    .command(SessionCommand)
    .command(PluginCommand)
    .command(DbCommand)
}
