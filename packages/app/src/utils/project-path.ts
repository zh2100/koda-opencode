const INVALID = /[\\/:*?"<>|]/

export function joinProjectPath(location: string, name: string) {
  const parent = location.replace(/[/\\]+$/, "")
  const sep = location.includes("\\") ? "\\" : "/"
  return `${parent}${sep}${name}`
}

export function projectNameInvalid(name: string) {
  const value = name.trim()
  if (!value) return "name"
  if (value === "." || value === ".." || INVALID.test(value)) return "invalid"
}
