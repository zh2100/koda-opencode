import {
  EffectFlockLayer,
  EffectFlockLockCompromisedError,
  EffectFlockLockDiagnosis,
  EffectFlockLockDiagnosisReason,
  EffectFlockLockTimeoutError,
  EffectFlockNode,
  EffectFlockService,
} from "./effect-flock"
import type {
  EffectFlockInterface,
  EffectFlockLockCompromisedErrorType,
  EffectFlockLockDiagnosisType,
  EffectFlockLockError,
  EffectFlockLockTimeoutErrorType,
  EffectFlockProbe,
  EffectFlockServiceType,
} from "./effect-flock"

export namespace EffectFlock {
  export const LockDiagnosisReason = EffectFlockLockDiagnosisReason
  export const LockDiagnosis = EffectFlockLockDiagnosis
  export type LockDiagnosis = EffectFlockLockDiagnosisType
  export const LockTimeoutError = EffectFlockLockTimeoutError
  export type LockTimeoutError = EffectFlockLockTimeoutErrorType
  export const LockCompromisedError = EffectFlockLockCompromisedError
  export type LockCompromisedError = EffectFlockLockCompromisedErrorType
  export const Service = EffectFlockService
  export type Service = EffectFlockServiceType
  export const layer = EffectFlockLayer
  export const node = EffectFlockNode
  export type Interface = EffectFlockInterface
  export type LockError = EffectFlockLockError
  export type Probe = EffectFlockProbe
}
