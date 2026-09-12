import path from "path"

process.env.OPENCODE_DB = ":memory:"
process.env.NPM_CONFIG_AUDIT = "false"
process.env.OPENCODE_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.OPENCODE_DISABLE_MODELS_FETCH = "true"
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_BASE_URL
delete process.env.OPENAI_API_KEY
delete process.env.OPENAI_BASE_URL
