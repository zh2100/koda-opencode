// Load before Happy DOM. Preserve real TCP and bridge the DOM AbortSignal to Bun's native one.
const transport = globalThis.fetch
const Controller = globalThis.AbortController
const NativeResponse = globalThis.Response
export const httpFetch: typeof fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const controller = new Controller()
    const cancel = () => controller.abort(init?.signal?.reason)
    if (init?.signal?.aborted) cancel()
    init?.signal?.addEventListener("abort", cancel, { once: true })
    try {
      const response = await transport(input, { ...init, signal: controller.signal })
      const bytes = await response.arrayBuffer()
      return new NativeResponse(response.status === 204 ? null : bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } finally {
      init?.signal?.removeEventListener("abort", cancel)
    }
  },
  { preconnect: transport.preconnect },
)
