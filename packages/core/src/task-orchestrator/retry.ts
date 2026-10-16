export * as TaskOrchestratorRetry from "./retry"

import { Schema } from "effect"
import { TaskOrchestratorReview } from "./review"

export const Input = Schema.Struct({
  review: TaskOrchestratorReview.Stored,
  maxRetries: Schema.Int,
  stepRetryCount: Schema.Int,
})

export type Input = typeof Input.Type

export type Transition =
  | {
      readonly action: "continue"
      readonly stepStatus: "completed"
      readonly taskStatus: "pending"
      readonly runStatus: "completed"
      readonly retryCount: number
    }
  | {
      readonly action: "revise"
      readonly stepStatus: "needs_revision"
      readonly taskStatus: "pending"
      readonly runStatus: "needs_revision"
      readonly retryCount: number
      readonly workerPrompt: string
    }
  | {
      readonly action: "fail"
      readonly stepStatus: "failed"
      readonly taskStatus: "failed"
      readonly runStatus: "failed"
      readonly retryCount: number
      readonly failureReason: string
    }

export const transition = (input: Input): Transition => {
  const retryCount = Math.max(0, input.stepRetryCount)
  const maxRetries = Math.max(0, input.maxRetries)
  if (input.review.action === "continue") {
    return { action: "continue", stepStatus: "completed", taskStatus: "pending", runStatus: "completed", retryCount }
  }
  if (input.review.action === "revise" && retryCount < maxRetries && input.review.workerPrompt) {
    return {
      action: "revise",
      stepStatus: "needs_revision",
      taskStatus: "pending",
      runStatus: "needs_revision",
      retryCount: retryCount + 1,
      workerPrompt: input.review.workerPrompt,
    }
  }
  return {
    action: "fail",
    stepStatus: "failed",
    taskStatus: "failed",
    runStatus: "failed",
    retryCount,
    failureReason:
      !input.review.approved && retryCount >= maxRetries ? "Reviewer retry limit reached" : "Reviewer rejected the result",
  }
}
