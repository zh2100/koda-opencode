export function decodeDataUrl(url: string) {
  return Buffer.from(decodeDataUrlBytes(url)).toString("utf8")
}

export function decodeDataUrlBytes(url: string) {
  const idx = url.indexOf(",")
  if (idx === -1) return Buffer.alloc(0)

  const head = url.slice(0, idx)
  const body = url.slice(idx + 1)
  if (head.includes(";base64")) return Buffer.from(body, "base64")
  return Buffer.from(decodeURIComponent(body), "utf8")
}
