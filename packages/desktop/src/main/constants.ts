type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

// Only production builds use the Koda GitHub Releases feed. Development and beta
// builds must not download production installers from the updater.
export const UPDATER_ENABLED = CHANNEL === "prod"
