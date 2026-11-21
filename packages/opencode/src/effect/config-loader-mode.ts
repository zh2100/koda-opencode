import { Context } from "effect"

// A write request still fully bootstraps, but optional loader writes must not
// invalidate the exact source version that the caller is about to submit.
export const ConfigLoaderWrites = Context.Reference<boolean>("@opencode/ConfigLoaderWrites", { defaultValue: () => true })
