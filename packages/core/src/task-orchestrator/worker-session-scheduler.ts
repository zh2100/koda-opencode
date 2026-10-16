export * as TaskOrchestratorWorkerSessionScheduler from "./worker-session-scheduler"

import { Effect } from "effect"
import { SessionV2 } from "../session"
import { TaskOrchestratorWorkerScheduler } from "./worker-scheduler"

export const make = (input: {
  readonly sessionID: Parameters<SessionV2.Interface["prompt"]>[0]["sessionID"]
  readonly prompt: SessionV2.Interface["prompt"]
}): TaskOrchestratorWorkerScheduler.Interface<
  Effect.Success<ReturnType<SessionV2.Interface["prompt"]>>,
  Effect.Error<ReturnType<SessionV2.Interface["prompt"]>>
> => ({
  schedule: ({ prompt, retryCount }) =>
    input.prompt({
      sessionID: input.sessionID,
      prompt: {
        text: `Worker revision #${retryCount}:\n\n${prompt}`,
      },
    }),
})
