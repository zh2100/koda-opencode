import { InstanceWork } from "@/effect/instance-work"
let calls = 0
for (let i = 0; i < 1030; i++) await InstanceWork.handoff(async () => { calls++; throw new Error("PRIVATE-HANDOFF-TOKEN") }).catch(() => undefined)
const before = InstanceWork.handoffDiagnostics()
const errors: string[] = []
for (let i = 0; i < 2; i++) await InstanceWork.drainAll().catch((error) => errors.push(error.message))
console.log(JSON.stringify({ before, after: InstanceWork.handoffDiagnostics(), calls, errors }))
