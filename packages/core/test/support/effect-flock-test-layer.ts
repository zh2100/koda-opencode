import { makeGlobalNode } from "../../src/effect/app-node"
import { FSUtil } from "../../src/fs-util"
import { Global } from "../../src/global"
import { EffectFlock } from "../../src/util/effect-flock"

// Test-only composition: ownership and retry logic remain in the production layer.
export function createEffectFlockTestNode(options: { readonly onWait: (event: EffectFlock.WaitObservation) => void }) {
  return makeGlobalNode({
    service: EffectFlock.Service,
    layer: EffectFlock.layerWith(options),
    deps: [Global.node, FSUtil.node],
  })
}
