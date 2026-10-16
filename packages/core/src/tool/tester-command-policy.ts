export * as TesterCommandPolicy from "./tester-command-policy"

const allowedPrefixes = [
  "bun test",
  "bun run test",
  "bun run typecheck",
  "bun run lint",
  "npm test",
  "npm run test",
  "npm run typecheck",
  "npm run lint",
  "pnpm test",
  "pnpm run test",
  "pnpm run typecheck",
  "pnpm run lint",
  "yarn test",
  "yarn run test",
  "cargo test",
  "go test",
  "pytest",
  "git diff --check",
  "git status",
] as const

const shellMutation = /[;&|<>`\n\r]|\$\(/u
const dangerousWord = /(^|\s)(rm|rmdir|del|erase|mv|move|cp|copy|install|uninstall|add|remove|checkout|reset|clean|commit|push|pull)(\s|$)/iu

export const isAllowed = (command: string) => {
  const normalized = command.trim().replaceAll(/\s+/gu, " ")
  if (normalized.length === 0 || shellMutation.test(normalized) || dangerousWord.test(normalized)) return false
  return allowedPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `))
}

export const allowed = [...allowedPrefixes]
