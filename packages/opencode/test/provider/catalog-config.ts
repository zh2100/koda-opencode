export const anthropicProvider = {
  env: ["ANTHROPIC_API_KEY"],
  npm: "@ai-sdk/anthropic",
  models: {
    "claude-sonnet-4-6": {
      name: "Claude Sonnet 4.6",
      reasoning: true,
      attachment: true,
      tool_call: true,
      family: "claude-sonnet",
      limit: { context: 200000, output: 64000 },
    },
    "claude-sonnet-4-20250514": { name: "Claude Sonnet 4" },
    "claude-opus-4-6": { name: "Claude Opus 4.6", reasoning: true },
    "claude-haiku-4-5": { name: "Claude Haiku 4.5", family: "claude-haiku" },
  },
}

export const openaiProvider = {
  env: ["OPENAI_API_KEY"],
  npm: "@ai-sdk/openai",
  models: {
    "gpt-5": { name: "GPT-5", reasoning: true },
    "gpt-5-chat-latest": { name: "GPT-5 Chat" },
  },
}

export const googleProvider = {
  env: ["GOOGLE_GENERATIVE_AI_API_KEY"],
  npm: "@ai-sdk/google",
  models: {
    "gemini-3.5-flash": {
      name: "Gemini 3.5 Flash",
      cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
    },
  },
}

export const bedrockProvider = {
  env: ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_BEARER_TOKEN_BEDROCK"],
  models: {
    "anthropic.claude-opus-4-5-20251101-v1:0": { name: "Claude Opus 4.5" },
  },
}

export const cloudflareGatewayProvider = {
  env: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID", "CLOUDFLARE_API_TOKEN"],
  models: {
    "openai/gpt-5.4": { name: "GPT-5.4" },
  },
}

export const googleVertexProvider = {
  env: ["GOOGLE_CLOUD_PROJECT", "VERTEX_LOCATION"],
  npm: "@ai-sdk/google-vertex",
  models: {
    "gemini-3.5-flash": { name: "Gemini 3.5 Flash", family: "gemini-flash" },
    "claude-sonnet-4-6@default": {
      name: "Claude Sonnet 4.6",
      provider: { npm: "@ai-sdk/google-vertex/anthropic" },
    },
  },
}

export const googleVertexAnthropicProvider = {
  env: ["GOOGLE_CLOUD_PROJECT", "VERTEX_LOCATION"],
  npm: "@ai-sdk/google-vertex/anthropic",
  models: {
    "claude-sonnet-4-6@default": { name: "Claude Sonnet 4.6" },
  },
}

export const nvidiaProvider = {
  models: {
    "nvidia-model": { name: "NVIDIA Model" },
  },
}

export const openrouterProvider = {
  env: ["OPENROUTER_API_KEY"],
  api: "https://openrouter.ai/api/v1",
  models: {
    "prime-intellect/intellect-3": {},
    "deepseek/deepseek-r1-0528": { name: "DeepSeek R1" },
  },
}

export const opencodeProvider = {
  env: ["OPENCODE_API_KEY"],
  models: {
    "kimi-k2.5-free": { name: "Kimi K2.5 Free", cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
    "kimi-k2.5": { name: "Kimi K2.5", cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 } },
  },
}

export const digitaloceanProvider = {
  env: ["DIGITALOCEAN_ACCESS_TOKEN"],
  npm: "@ai-sdk/openai-compatible",
  api: "https://inference.do-ai.run/v1",
  models: {
    "anthropic-claude-haiku-4.5": { name: "Claude Haiku 4.5" },
  },
}

export const leidiandonghuaProvider = {
  name: "雷电动画",
  models: {
    placeholder: { name: "Placeholder" },
  },
}
