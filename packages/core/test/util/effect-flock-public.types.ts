import { EffectFlock } from "@opencode-ai/core/util/effect-flock"

const diagnosis: EffectFlock.LockDiagnosis = new EffectFlock.LockDiagnosis({ reason: "live-owner" })
const timeout: EffectFlock.LockTimeoutError = new EffectFlock.LockTimeoutError({ key: "test" })
const compromised: EffectFlock.LockCompromisedError = new EffectFlock.LockCompromisedError({ detail: "test" })

void diagnosis
void timeout
void compromised

// @ts-expect-error The internal wait seam is not part of the public package API.
EffectFlock.layerWith

// @ts-expect-error The internal observation type is not part of the public package API.
type HiddenObservation = EffectFlock.WaitObservation

void (undefined as HiddenObservation | undefined)
