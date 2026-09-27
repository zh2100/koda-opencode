const proc = Bun.spawn([
  "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
  "/nologo",
  "/r:System.Web.Extensions.dll",
  `/out:${import.meta.dir}\\..\\..\\..\\desktop\\resources\\windows-fetch-proxy.exe`,
  `${import.meta.dir}\\windows-fetch-proxy\\Program.cs`,
], { stdout: "inherit", stderr: "inherit" })
if ((await proc.exited) !== 0) process.exit(1)
