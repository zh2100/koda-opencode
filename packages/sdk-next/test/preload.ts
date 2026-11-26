import { join } from "node:path"
import { loadGlobal, preload } from "../../../script/test-isolation.mjs"

const { root } = preload("opencode-sdk-next-test-")
// Database.node resolves the filename on import; keep it valid for every embedded host in the suite.
process.env.OPENCODE_DB = join(root, "embedded.sqlite")
await loadGlobal(root)
