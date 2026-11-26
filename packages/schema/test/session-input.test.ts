import { expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { Prompt } from "../src/prompt"
import { SessionInput } from "../src/session-input"
import { SessionID } from "../src/session-id"
import { SessionMessage } from "../src/session-message"

test("admission lifecycle fields omit undefined but preserve an explicit invalidation sequence", () => {
  const admitted = SessionInput.Admitted.make({
    admittedSeq: 0,
    id: SessionMessage.ID.make("msg_schema_input"),
    sessionID: SessionID.make("ses_schema_input"),
    prompt: Prompt.make({ text: "Queued" }),
    delivery: "queue",
    timeCreated: DateTime.makeUnsafe(0),
    promotedSeq: undefined,
    invalidatedSeq: undefined,
  })
  const encoded = Schema.encodeSync(SessionInput.Admitted)(admitted)
  expect(Object.hasOwn(encoded, "promotedSeq")).toBe(false)
  expect(Object.hasOwn(encoded, "invalidatedSeq")).toBe(false)
  expect(Schema.encodeSync(SessionInput.Admitted)({ ...admitted, invalidatedSeq: 2 })).toEqual({
    ...encoded,
    invalidatedSeq: 2,
  })
})

test("pending snapshots accept an empty-stream watermark but reject fractional or older watermarks", () => {
  const decode = Schema.decodeUnknownSync(SessionInput.Pending)
  expect(decode({ sessionID: "ses_schema_input", sequence: -1, inputs: [] })).toEqual({
    sessionID: SessionID.make("ses_schema_input"),
    sequence: -1,
    inputs: [],
  })
  for (const sequence of [-2, 0.5]) {
    expect(() => decode({ sessionID: "ses_schema_input", sequence, inputs: [] })).toThrow()
  }
})
