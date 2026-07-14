import { eq, sql } from "drizzle-orm";
import { events, eventSourceState } from "./schema";
import { matchSeatGeek } from "./match";
import type { TmEvent, tmClient } from "./tm";
import type { sgClient } from "./sg";

export const SEED_BUDGET = 50;     // reserved out of the 150 global cap (spec §6)
export const SG_RETRY_LIMIT = 25;  // bounded nightly match retries (spec §5)

export async function upsertTmEvent(db: any, ev: TmEvent, opts: { isSeed: boolean }): Promise<number> {
  const rows = await db.insert(events).values({
    tmId: ev.tmId, name: ev.name, artist: ev.artist, venue: ev.venue, city: ev.city,
    eventTz: ev.eventTz, startsAt: ev.startsAt, artworkUrl: ev.artworkUrl, genre: ev.genre,
    isSeed: opts.isSeed, pollingEnabled: opts.isSeed,
  }).onConflictDoUpdate({
    target: events.tmId,
    set: { isSeed: sql`events.is_seed OR ${opts.isSeed}`,
           pollingEnabled: sql`events.polling_enabled OR ${opts.isSeed}` },
  }).returning({ id: events.id });
  const id = rows[0].id;
  await db.insert(eventSourceState).values({ eventId: id, source: "tm" }).onConflictDoNothing();
  return id;
}

export async function runNightly(
  db: any, tm: ReturnType<typeof tmClient>, sg: ReturnType<typeof sgClient>,
): Promise<void> {
  // 1. Past-event lifecycle: free user slots AND seed budget (is_seed cleared — spec §5 nightly)
  await db.execute(sql`
    WITH aged AS (
      UPDATE events SET event_status = 'past', polling_enabled = false, is_seed = false
      WHERE starts_at < now() - interval '24 hours' AND event_status <> 'past'
      RETURNING id)
    DELETE FROM watchlist_events WHERE event_id IN (SELECT id FROM aged)
  `);

  // 2. 90-day snapshot TTL
  await db.execute(sql`DELETE FROM price_snapshots WHERE poll_bucket < now() - interval '90 days'`);

  // 3. Seed refresh up to budget; skip if full of future seeds — never evict live seeds
  const [{ count }] = (await db.execute(sql`SELECT count(*)::int AS count FROM events WHERE is_seed`)).rows;
  const room = SEED_BUDGET - Number(count);
  if (room > 0) {
    const popular = await tm.popular(SEED_BUDGET + 10);
    let added = 0;
    for (const ev of popular) {
      if (added >= room) break;
      const [existing] = await db.select({ isSeed: events.isSeed }).from(events).where(eq(events.tmId, ev.tmId));
      const becameSeed = !existing?.isSeed; // new row OR existing non-seed → this run turns it into a seed
      const id = await upsertTmEvent(db, ev, { isSeed: true });
      if (becameSeed) added++; // every is_seed transition counts against the budget, not just inserts
      if (!existing) {
        try { await matchSeatGeek(db, id, sg); } catch { /* retried by nightly pass */ }
      }
    }
  }

  // 4. SG match retry pass: bounded, oldest attempts first
  const unmatched = (await db.execute(sql`
    SELECT id FROM events
    WHERE polling_enabled AND sg_id IS NULL
      AND (matched_at IS NULL OR matched_at < now() - interval '24 hours')
    ORDER BY matched_at NULLS FIRST LIMIT ${SG_RETRY_LIMIT}
  `)).rows as { id: number }[];
  for (const { id } of unmatched) {
    try { await matchSeatGeek(db, id, sg); } catch { /* retried by nightly pass */ }
  }
}
