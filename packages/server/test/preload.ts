import { preload, confirm } from "../../../script/test-isolation.mjs"

const admission = preload("opencode-server-test-")
confirm(admission)
const { ResourceRoot } = await import("../../core/src/resource-root")
const { LockProtocol } = await import("../../core/src/util/lock-protocol")
const selected = ResourceRoot.select(ResourceRoot.defaultPaths(), admission.home)
LockProtocol.resolve("test-isolation-admission", selected.context)
confirm(admission)
