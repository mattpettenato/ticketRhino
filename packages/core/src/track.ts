import { sql } from "drizzle-orm";
import { matchSeatGeek } from "./match";
import { upsertTmEvent } from "./nightly";
import type { TmEvent } from "./tm";
import type { sgClient } from "./sg";

export const USER_POOL_CAP = 100; // + 50 seed = 150 global (spec §6)
export const PER_USER_CAP = 20;

export type TrackResult = { ok: true; eventId: number } | { ok: false; reason: "user_cap" | "global_cap" };

// Track is ONE transaction (spec §6). Requires interactive-transaction driver (Pool), not neon-http.
export async function trackEvent(
  db: any, anonId: string, tmEvent: TmEvent, sg: ReturnType<typeof sgClient>,
): Promise<TrackResult> {
  const result: TrackResult = await db.transaction(async (tx: any) => {
    const [{ mine }] = (await tx.execute(sql`
      SELECT count(*)::int AS mine FROM watchlist_events WHERE anon_id = ${anonId}`)).rows;
    if (Number(mine) >= PER_USER_CAP) return { ok: false, reason: "user_cap" };

    const existing = (await tx.execute(sql`
      SELECT id, polling_enabled FROM events WHERE tm_id = ${tmEvent.tmId} FOR UPDATE`)).rows[0];

    const needsSlot = !existing || !existing.polling_enabled;
    if (needsSlot) {
      const poolCount = async () => Number((await tx.execute(sql`
        SELECT count(*)::int AS c FROM events WHERE polling_enabled AND NOT is_seed`)).rows[0].c);
      if (await poolCount() >= USER_POOL_CAP) {
        // early nightly cleanup: purge STARTED events for all users (never future ones — spec §6)
        await tx.execute(sql`
          WITH started AS (
            UPDATE events SET polling_enabled = false
            WHERE polling_enabled AND NOT is_seed AND starts_at < now()
            RETURNING id)
          DELETE FROM watchlist_events WHERE event_id IN (SELECT id FROM started)`);
        if (await poolCount() >= USER_POOL_CAP) return { ok: false, reason: "global_cap" };
      }
    }

    const eventId = existing?.id ?? await upsertTmEvent(tx, tmEvent, { isSeed: false });
    await tx.execute(sql`
      UPDATE events SET polling_enabled = true, tracked_at = coalesce(tracked_at, now())
      WHERE id = ${eventId}`);
    await tx.execute(sql`
      INSERT INTO watchlist_events (anon_id, event_id) VALUES (${anonId}, ${eventId})
      ON CONFLICT DO NOTHING`);
    return { ok: true, eventId };
  });

  // SG match AFTER commit: network call must not sit inside the transaction
  if (result.ok) await matchSeatGeek(db, result.eventId, sg).catch(() => {});
  return result;
}

export async function untrackEvent(db: any, anonId: string, eventId: number): Promise<void> {
  await db.transaction(async (tx: any) => {
    await tx.execute(sql`
      DELETE FROM watchlist_events WHERE anon_id = ${anonId} AND event_id = ${eventId}`);
    // invariant: polling_enabled = is_seed OR watchers > 0
    await tx.execute(sql`
      UPDATE events e SET polling_enabled = (e.is_seed OR EXISTS (
        SELECT 1 FROM watchlist_events w WHERE w.event_id = e.id))
      WHERE e.id = ${eventId}`);
  });
}
