import { describe, expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { Model } from "../src/model"
import { Project } from "../src/project"
import { Prompt } from "../src/prompt"
import { Provider } from "../src/provider"
import { Relay } from "../src/relay"
import { RelayError } from "../src/relay-error"
import { RelayModel } from "../src/relay-model"
import { AbsolutePath } from "../src/schema"
import { ScheduledTask } from "../src/scheduled-task"

const now = DateTime.makeUnsafe(1_704_067_200_000)

describe("relay contracts", () => {
  test("vendor IDs accept the documented pattern and reject invalid values", () => {
    expect(Schema.decodeUnknownSync(Relay.VendorID)("chatgpt")).toBe(Relay.VendorID.chatgpt)
    expect(Schema.decodeUnknownSync(Relay.VendorID)("kimi")).toBe(Relay.VendorID.make("kimi"))
    expect(() => Schema.decodeUnknownSync(Relay.VendorID)("ChatGPT")).toThrow()
    expect(() => Schema.decodeUnknownSync(Relay.VendorID)("-bad")).toThrow()
  })

  test("auth state omits secret material", () => {
    const encoded = Schema.encodeSync(Relay.AuthState)({
      unified: true,
      hasUnifiedKey: true,
      vendors: [
        {
          id: Relay.VendorID.chatgpt,
          name: "ChatGPT",
          builtin: true,
          hasKey: true,
          updatedAt: now,
          revision: 1,
        },
      ],
      revision: 2,
      canRollback: false,
    })

    expect(encoded).toEqual({
      unified: true,
      hasUnifiedKey: true,
      vendors: [
        {
          id: "chatgpt",
          name: "ChatGPT",
          builtin: true,
          hasKey: true,
          updatedAt: 1_704_067_200_000,
          revision: 1,
        },
      ],
      revision: 2,
      canRollback: false,
    })
    expect(JSON.stringify(encoded)).not.toContain("sk-")
    expect(JSON.stringify(encoded)).not.toContain("keyFingerprint")
  })

  test("candidate DTO omits key fingerprints and undefined keys", () => {
    const encoded = Schema.encodeSync(RelayModel.Candidate)({
      vendorId: Relay.VendorID.chatgpt,
      modelId: Model.ID.make("gpt-5.2"),
      fetchedAt: now,
      assignmentSource: "manual",
      upstreamPresent: true,
    })

    expect(encoded).toEqual({
      vendorId: "chatgpt",
      modelId: "gpt-5.2",
      fetchedAt: 1_704_067_200_000,
      assignmentSource: "manual",
      upstreamPresent: true,
    })
    expect("keyFingerprint" in encoded).toBe(false)
    expect("displayName" in encoded).toBe(false)
  })

  test("conflict error code is part of the public union", () => {
    const encoded = Schema.encodeSync(RelayError.Info)({
      code: "MODEL_VENDOR_CONFLICT",
      retryable: false,
      requestId: "req_1",
    })
    expect(encoded.code).toBe("MODEL_VENDOR_CONFLICT")
  })

  test("scheduled task IDs expose create and omit undefined", () => {
    expect(ScheduledTask.ID.create()).toStartWith("stk_")
    expect(ScheduledTask.RunID.create()).toStartWith("trn_")

    const encoded = Schema.encodeSync(ScheduledTask.Run)({
      id: ScheduledTask.RunID.create(),
      taskId: ScheduledTask.ID.create(),
      scheduledAt: now,
      revision: 1,
      status: "pending",
    })
    expect(encoded).not.toHaveProperty("sessionId")
    expect(encoded).not.toHaveProperty("error")
  })

  test("public identifiers are unique", () => {
    const identifiers = [
      Relay.Vendor,
      Relay.AuthState,
      Relay.Effort,
      RelayModel.Candidate,
      RelayModel.Managed,
      RelayError.Code,
      RelayError.Info,
      ScheduledTask.Info,
      ScheduledTask.Run,
    ].map((schema) => schema.ast.annotations?.identifier)

    expect(identifiers.every((identifier) => typeof identifier === "string")).toBe(true)
    expect(new Set(identifiers).size).toBe(identifiers.length)
  })

  test("scheduled task accepts a prompt without leaking extra keys", () => {
    const encoded = Schema.encodeSync(ScheduledTask.Info)({
      id: ScheduledTask.ID.create(),
      name: "daily check",
      projectID: Project.ID.global,
      location: { directory: AbsolutePath.make("/tmp/project") },
      prompt: Prompt.make({ text: "check deps" }),
      schedule: "daily",
      timezone: "Asia/Shanghai",
      runAt: now,
      model: {
        id: Model.ID.make("gpt-5.2"),
        providerID: Provider.ID.make("leidiandonghua"),
      },
      approvalMode: "auto",
      enabled: true,
      revision: 1,
    })

    expect(encoded.prompt).toEqual({ text: "check deps" })
    expect(encoded).not.toHaveProperty("effort")
  })
})
