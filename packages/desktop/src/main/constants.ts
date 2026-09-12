type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

// Koda checks its fixed release tag through the Help menu; the legacy updater
// must not download OpenCode releases when building the production channel.
export const UPDATER_ENABLED = false
