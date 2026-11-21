export function descendantProbe(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid descendant PID")
  return process.platform === "win32"
    ? ["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]
    : ["ps", "-eo", "pid="]
}

export function listsDescendant(stdout: string, pid: number) {
  return process.platform === "win32"
    ? stdout.includes(`"${pid}"`)
    : stdout.split("\n").some((line) => line.trim() === String(pid))
}
