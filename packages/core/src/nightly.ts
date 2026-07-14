import { eq, inArray, sql } from "drizzle-orm";
import { events, eventSourceState } from "./schema";
import { matchSeatGeek } from "./match";
import type { FetchBudget } from "./backoff";
import type { TmEvent, tmClient } from "./tm";
import type { sgClient } from "./sg";

export const SEED_BUDGET = 50; // reserved out of the 150 global cap (spec §6)

// Nightly CF subrequest budget (neon-http = 1 subrequest per statement; hard CF limit is 50,
// we target ≤45 for headroom). A subrequest is either a DB statement OR an external fetch.
// DB statements (always issued — NOT budgeted):
//   fixed 7: past-lifecycle 1 + snapshot-TTL 1 + retry-pass-select 1 + seed-count 1
//            + existing-select 1 + batched-upsert 1 + batched-source-insert 1
//            (fixed regardless of seed count — all writes are batched).
//   per SG retry ≤3: event-select 1 + update-events 1 + insert-source-state 1 (on match).
//   worst-case statements = 7 + 3·SG_RETRY_LIMIT = 7 + 27 = 34.
// Fetches (tm.popular + one sg.searchCandidates per retry, EACH up to 3 backoff tries on 5xx —
//   that's the unbudgeted blow-up: 9 retries × 3 tries + popular × 3 = 30 fetches by itself).
//   A shared FetchBudget caps TOTAL fetches this run; once exhausted a call simply doesn't fetch
//   (returns null → treated as no-match, DB statements still run). Total ≤ 34 + budget ≤ 45
//   →  budget ≤ 11. Happy path needs popular 1 + 9 searches = 10 ≤ 11 (one spare retry attempt).
// SG_RETRY_LIMIT: the spec's original LIMIT 25 assumed the run fit the budget; it does not — the
//   50-subrequest hard limit governs. Unmatched events accumulate across nights, so a smaller
//   per-night limit is fine.
export const SG_RETRY_LIMIT = 9;
export const NIGHTLY_FETCH_BUDGET = 11;

// Refresh TM-sourced mutable display fields on conflict; PRESERVE the monotonic is_seed /
// polling_enabled OR-merge (a row never loses seed/polling status via an upsert). The events
// table has no price columns (prices live in price_snapshots), so there are no price fields to
// refresh here.
const TM_REFRESH_SET = {
  name: sql`excluded.name`,
  artist: sql`excluded.artist`,
  venue: sql`excluded.venue`,
  city: sql`excluded.city`,
  eventTz: sql`excluded.event_tz`,
  startsAt: sql`excluded.starts_at`,
  artworkUrl: sql`excluded.artwork_url`,
  genre: sql`excluded.genre`,
  isSeed: sql`events.is_seed OR excluded.is_seed`,
  pollingEnabled: sql`events.polling_enabled OR excluded.polling_enabled`,
} as const;

export async function upsertTmEvent(db: any, ev: TmEvent, opts: { isSeed: boolean }): Promise<number> {
  const rows = await db.insert(events).values({
    tmId: ev.tmId, name: ev.name, artist: ev.artist, venue: ev.venue, city: ev.city,
    eventTz: ev.eventTz, startsAt: ev.startsAt, artworkUrl: ev.artworkUrl, genre: ev.genre,
    isSeed: opts.isSeed, pollingEnabled: opts.isSeed,
  }).onConflictDoUpdate({ target: events.tmId, set: TM_REFRESH_SET }).returning({ id: events.id });
  const id = rows[0].id;
  await db.insert(eventSourceState).values({ eventId: id, source: "tm" }).onConflictDoNothing();
  return id;
}

export async function runNightly(
  db: any, tm: ReturnType<typeof tmClient>, sg: ReturnType<typeof sgClient>,
): Promise<void> {
  const budget: FetchBudget = { remaining: NIGHTLY_FETCH_BUDGET }; // shared across all fetches this run
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

  // 3. SG match retry pass — runs BEFORE seed refresh (spec §5). New seeds added by this run get
  //    matched on the NEXT nightly's retry pass, keeping seed refresh a fixed, batched cost and
  //    all network match calls inside the bounded, error-isolated retry loop.
  const unmatched = (await db.execute(sql`
    SELECT id FROM events
    WHERE polling_enabled AND sg_id IS NULL
      AND (matched_at IS NULL OR matched_at < now() - interval '24 hours')
    ORDER BY matched_at NULLS FIRST LIMIT ${SG_RETRY_LIMIT}
  `)).rows as { id: number }[];
  for (const { id } of unmatched) {
    try { await matchSeatGeek(db, id, sg, budget); } catch { /* per-event isolation — next night retries */ }
  }

  // 4. Seed refresh up to budget; skip if full of future seeds — never evict live seeds.
  //    Fully batched: ONE existing-select, ONE multi-row upsert, ONE multi-row source-state insert.
  const [{ count }] = (await db.execute(sql`SELECT count(*)::int AS count FROM events WHERE is_seed`)).rows;
  const room = SEED_BUDGET - Number(count);
  if (room > 0) {
    const popular = await tm.popular(SEED_BUDGET + 10, budget);
    if (popular.length) {
      const tmIds = popular.map((e) => e.tmId);
      const existing = await db.select({ tmId: events.tmId, isSeed: events.isSeed })
        .from(events).where(inArray(events.tmId, tmIds));
      const seedByTmId = new Map<string, boolean>(existing.map((e: any) => [e.tmId, e.isSeed]));

      // Queue popular in order; every is_seed transition (new row OR existing non-seed) counts
      // against `room`. Already-seed events are refreshed but don't consume budget.
      const batch: TmEvent[] = [];
      const seen = new Set<string>(); // dedupe: ON CONFLICT DO UPDATE can't hit the same tmId twice in one upsert
      let flips = 0;
      for (const ev of popular) {
        if (seen.has(ev.tmId)) continue;
        seen.add(ev.tmId);
        if (seedByTmId.get(ev.tmId) !== true) {
          if (flips >= room) continue;
          flips++;
        }
        batch.push(ev);
      }

      if (batch.length) {
        const rows = await db.insert(events).values(batch.map((ev) => ({
          tmId: ev.tmId, name: ev.name, artist: ev.artist, venue: ev.venue, city: ev.city,
          eventTz: ev.eventTz, startsAt: ev.startsAt, artworkUrl: ev.artworkUrl, genre: ev.genre,
          isSeed: true, pollingEnabled: true,
        }))).onConflictDoUpdate({ target: events.tmId, set: TM_REFRESH_SET })
          .returning({ id: events.id });
        await db.insert(eventSourceState)
          .values(rows.map((r: { id: number }) => ({ eventId: r.id, source: "tm" })))
          .onConflictDoNothing();
      }
    }
  }
}
