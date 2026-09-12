export function clipboardImageBuffer(png: Uint8Array) {
  // IPC must transfer only the PNG view, not the surrounding Node Buffer pool.
  return Uint8Array.from(png).buffer
}
