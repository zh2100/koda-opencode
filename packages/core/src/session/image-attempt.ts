import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"

export type ImageSlot = {
  readonly session: string
  readonly task: string
  readonly slot: string
  readonly call: string
}

// The limit predicate and unique slot claim are in the SAME SQLite write statement.
// No lease expiry: even a crash just before the POST leaves a conservative unknown outcome.
export const reserveImage = Effect.fn("ImageAttempt.reserve")(function* (
  db: Database.Interface["db"],
  key: ImageSlot,
  model: string,
  limit: number,
  confirmed: boolean,
) {
  const used = sql`select count(*) from image_attempt where session_id=${key.session} and task_id=${key.task}`
  const row = yield* db
    .get(
      sql`insert into image_attempt(session_id,task_id,slot,call_id,model)
    select ${key.session},${key.task},${key.slot},${key.call},${model} where (${used}) < ${limit} or ${Number(confirmed)} = 1
    on conflict do nothing returning slot`,
    )
    .pipe(Effect.orDie)
  if (row) return "reserved" as const
  const existing = yield* db
    .get(
      sql`select slot from image_attempt where session_id=${key.session} and task_id=${key.task} and slot=${key.slot}`,
    )
    .pipe(Effect.orDie)
  return existing ? ("existing" as const) : ("limit" as const)
})

export const recordImageReceipt = (db: Database.Interface["db"], key: ImageSlot, digest: string) =>
  db
    .run(
      sql`update image_attempt set digest=${digest} where session_id=${key.session} and task_id=${key.task} and slot=${key.slot} and call_id=${key.call}`,
    )
    .pipe(Effect.orDie)
