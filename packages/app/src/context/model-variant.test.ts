import { describe, expect, test } from "bun:test"
import { cycleModelVariant, getConfiguredAgentVariant, modelVariantLabelKey, resolveModelVariant } from "./model-variant"

describe("model variant", () => {
  test("labels native efforts without treating independent Ultra presets as xhigh", () => {
    expect(modelVariantLabelKey("low")).toBe("model.variant.low")
    expect(modelVariantLabelKey("xhigh")).toBe("model.variant.xhigh")
    expect(modelVariantLabelKey("max")).toBe("model.variant.max")
    expect(modelVariantLabelKey("native-ultra")).toBe("model.variant.ultra")
    expect(modelVariantLabelKey("none")).toBe("model.variant.none")
    expect(modelVariantLabelKey("ultra")).toBeUndefined()
    expect(modelVariantLabelKey("custom")).toBeUndefined()
  })
  test("resolves configured agent variant when model matches", () => {
    const value = getConfiguredAgentVariant({
      agent: {
        model: { providerID: "openai", modelID: "gpt-5.2" },
        variant: "xhigh",
      },
      model: {
        providerID: "openai",
        modelID: "gpt-5.2",
        variants: { low: {}, high: {}, xhigh: {} },
      },
    })

    expect(value).toBe("xhigh")
  })

  test("ignores configured variant when model does not match", () => {
    const value = getConfiguredAgentVariant({
      agent: {
        model: { providerID: "openai", modelID: "gpt-5.2" },
        variant: "xhigh",
      },
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
        variants: { low: {}, high: {}, xhigh: {} },
      },
    })

    expect(value).toBeUndefined()
  })

  test("prefers selected variant over configured variant", () => {
    const value = resolveModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: "high",
      configured: "xhigh",
    })

    expect(value).toBe("high")
  })

  test("lets an explicit default override the configured variant", () => {
    const value = resolveModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: null,
      configured: "xhigh",
    })

    expect(value).toBeUndefined()
  })

  test("cycles from configured variant to next", () => {
    const value = cycleModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: undefined,
      configured: "high",
    })

    expect(value).toBe("xhigh")
  })

  test("wraps from configured last variant to first", () => {
    const value = cycleModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: undefined,
      configured: "xhigh",
    })

    expect(value).toBe("low")
  })

  test("cycles from an explicit default to the first variant", () => {
    const value = cycleModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: null,
      configured: "xhigh",
    })

    expect(value).toBe("low")
  })
})
