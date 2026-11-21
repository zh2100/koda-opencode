import path from "path"

const command = process.argv[2] ?? "plan"

if (command !== "plan") {
  console.error("apply, resume, and rollback are not enabled. This tool only prints a plan.")
  process.exit(2)
}

const source = process.argv[3]
if (!source) {
  console.error("usage: bun script/migrate-lock-root.ts plan <source-root>")
  process.exit(2)
}

const resolved = path.resolve(source)
const plan = {
  status: "planned",
  source: resolved,
  target: path.join(path.dirname(resolved), `${path.basename(resolved)}-next`),
  actions: [
    "inventory data, config, state, cache, sqlite, credentials, and external project files",
    "stop when a write target is outside the inventory",
    "create a new root in preparing state without publishing a completed marker",
    "do not touch the current production root from this command",
  ],
}

console.log(JSON.stringify(plan, null, 2))
