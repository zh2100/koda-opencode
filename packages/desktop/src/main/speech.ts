import { spawn } from "node:child_process"
import { app } from "electron"

const POWERSHELL = process.env.SystemRoot
  ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  : "powershell.exe"

const SCRIPT = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech
$culture = New-Object System.Globalization.CultureInfo "zh-CN"
$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($culture)
$engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$engine.SetInputToDefaultAudioDevice()
$engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds(6)
$engine.BabbleTimeout = [TimeSpan]::FromSeconds(10)
$engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(900)
$script:peak = 0
$level = Register-ObjectEvent -InputObject $engine -EventName AudioLevelUpdated -Action {
  if ($Event.SourceEventArgs.AudioLevel -gt $script:peak) { $script:peak = $Event.SourceEventArgs.AudioLevel }
}
$result = $engine.Recognize()
Unregister-Event -SourceIdentifier $level.Name
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if ($null -eq $result -or [string]::IsNullOrWhiteSpace($result.Text)) {
  if ($script:peak -gt 0) { exit 3 } else { exit 2 }
}
[Console]::Out.Write($result.Text)
`

export type SpeechResult = { text: string } | { error: "unavailable" | "empty" | "failed" }

export function recognizeSpeech(_lang?: unknown): Promise<SpeechResult> {
  if (process.platform !== "win32" || !app.isReady()) return Promise.resolve({ error: "unavailable" })
  return new Promise((resolve) => {
    const child = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-STA", "-Command", SCRIPT], {
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill()
      resolve({ error: "failed" })
    }, 20000)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.on("error", () => {
      clearTimeout(timer)
      resolve({ error: "unavailable" })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      const text = stdout.trim()
      if (text) {
        resolve({ text })
        return
      }
      resolve({ error: (code === 2 || code === 3) && !stderr.trim() ? "empty" : "failed" })
    })
  })
}
