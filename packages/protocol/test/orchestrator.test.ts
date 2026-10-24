import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { OrchestratorCreatePayload, OrchestratorTask } from "../src/groups/orchestrator"

describe("OrchestratorCreatePayload", () => {
  test("decodes the collaboration payload sent by the app", async () => {
    const payload = await Effect.runPromise(
      Schema.decodeUnknownEffect(OrchestratorCreatePayload)({
        sessionID: "ses_test",
        projectID: "prj_test",
        workspaceKey: "directory:d:/opencode",
        prompt: "implement the feature",
        models: {
          worker: "leidiandonghua/model",
          planner: "leidiandonghua/planner",
          mode: "parallel",
        },
      }),
    )

    expect(payload.models.worker).toBe("leidiandonghua/model")
    expect(payload.models.planner).toBe("leidiandonghua/planner")
    expect(payload.models.mode).toBe("parallel")
  })

  test("requires a worker model", async () => {
    const result = await Effect.runPromise(
      Effect.exit(
        Schema.decodeUnknownEffect(OrchestratorCreatePayload)({
          sessionID: "ses_test",
          projectID: "prj_test",
          workspaceKey: "directory:d:/opencode",
          prompt: "implement the feature",
          models: {},
        }),
      ),
    )

    expect(result._tag).toBe("Failure")
  })
})

describe("OrchestratorTask", () => {
  test("decodes task status responses", async () => {
    const task = await Effect.runPromise(
      Schema.decodeUnknownEffect(OrchestratorTask)({
        id: "task",
        sessionID: "ses_test",
        status: "running",
        currentStep: 2,
      }),
    )

    expect(task.status).toBe("running")

    const failed = await Effect.runPromise(
      Schema.decodeUnknownEffect(OrchestratorTask)({
        id: "task",
        sessionID: "ses_test",
        status: "failed",
        currentStep: 1,
        failureReason: "Worker t1 exceeded timeout of 900000ms",
      }),
    )
    expect(failed.failureReason).toBe("Worker t1 exceeded timeout of 900000ms")
  })
})
