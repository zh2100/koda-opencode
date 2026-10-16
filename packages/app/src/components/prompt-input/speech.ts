type SpeechWindow = Window & {
  api?: {
    recognizeSpeech?: (lang: string) => Promise<{ text: string } | { error: string }>
  }
  webkitSpeechRecognition?: new () => BrowserSpeech
  SpeechRecognition?: new () => BrowserSpeech
}

type BrowserSpeech = {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: (() => void) | null
  onend: (() => void) | null
  start: () => void
  abort: () => void
}

export type SpeechOutcome = { text: string } | { error: "unavailable" | "empty" | "failed" }

export function speechSupported() {
  if (typeof window === "undefined") return false
  const current = window as SpeechWindow
  if (typeof current.api?.recognizeSpeech === "function") return true
  return typeof current.webkitSpeechRecognition === "function" || typeof current.SpeechRecognition === "function"
}

export function recognizeSpeech(lang: string): Promise<SpeechOutcome> {
  const current = window as SpeechWindow
  if (typeof current.api?.recognizeSpeech === "function") {
    return current.api.recognizeSpeech(lang).then((result) => {
      if ("text" in result && result.text.trim()) return { text: result.text.trim() }
      if ("error" in result && (result.error === "unavailable" || result.error === "empty")) return { error: result.error }
      return { error: "failed" }
    })
  }
  const Ctor = current.webkitSpeechRecognition ?? current.SpeechRecognition
  if (!Ctor) return Promise.resolve({ error: "unavailable" })
  return new Promise((resolve) => {
    const recognition = new Ctor()
    recognition.lang = lang
    recognition.interimResults = false
    recognition.continuous = false
    recognition.onresult = (event) => {
      const text = event.results[0]?.[0]?.transcript?.trim() ?? ""
      resolve(text ? { text } : { error: "empty" })
    }
    recognition.onerror = () => resolve({ error: "failed" })
    recognition.onend = () => resolve({ error: "empty" })
    recognition.start()
  })
}
