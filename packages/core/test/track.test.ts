import { beforeEach, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { PER_USER_CAP, trackEvent, untrackEvent, USER_POOL_CAP } from "../src/track";
import { events, watchlistEvents } from "../src/schema";
import { testDb } from "./helpers";

const db = testDb();
const sgNone = { searchCandidates: vi.fn().mockResolvedValue([]) } as any;
const future = new Date(Date.now() + 7 * 86_400_000);
const tmEv = (i: number, startsAt = future) => ({
  tmId: `tm-${i}`, name: `Show ${i}`, artist: null, venue: null, city: null,
  eventTz: null, startsAt, artworkUrl: null, genre: null,
  priceLow: 1, priceHigh: 2, status: "onsale",
} as any);

beforeEach(async () => {
  await db.execute(sql`TRUNCATE price_snapshots, watchlist_events, event_source_state, events RESTART IDENTITY CASCADE`);
});

test("track creates event, source state, watchlist row; polling on", async () => {
  const res = await trackEvent(db, "u1", tmEv(1), sgNone);
  expect(res.ok).toBe(true);
  const [ev] = await db.select().from(events);
  expect(ev).toMatchObject({ pollingEnabled: true, isSeed: false });
  expect(await db.select().from(watchlistEvents)).toHaveLength(1);
});

test("per-user cap 20 rejects", async () => {
  for (let i = 0; i < PER_USER_CAP; i++) expect((await trackEvent(db, "u1", tmEv(i), sgNone)).ok).toBe(true);
  expect(await trackEvent(db, "u1", tmEv(99), sgNone)).toEqual({ ok: false, reason: "user_cap" });
});

test("second watcher on same event consumes no slot and succeeds", async () => {
  await trackEvent(db, "u1", tmEv(1), sgNone);
  const res = await trackEvent(db, "u2", tmEv(1), sgNone);
  expect(res.ok).toBe(true);
  expect(await db.select().from(events)).toHaveLength(1);
});

test("global cap full: purge of started events frees a slot; else reject", async () => {
  // fill pool with 100 distinct future user-tracked events across users (5 per user)
  for (let i = 0; i < USER_POOL_CAP; i++)
    expect((await trackEvent(db, `filler-${Math.floor(i / 5)}`, tmEv(i), sgNone)).ok).toBe(true);
  // no started events -> reject
  expect(await trackEvent(db, "u9", tmEv(500), sgNone)).toEqual({ ok: false, reason: "global_cap" });
  // make one event started -> purge frees it (all users' rows, event started)
  await db.execute(sql`UPDATE events SET starts_at = now() - interval '1 hour' WHERE tm_id = 'tm-0'`);
  const res = await trackEvent(db, "u9", tmEv(500), sgNone);
  expect(res.ok).toBe(true);
  const purged = await db.execute(sql`SELECT polling_enabled FROM events WHERE tm_id = 'tm-0'`);
  expect(purged.rows[0].polling_enabled).toBe(false);
});

test("concurrent tracks at cap 99: exactly one succeeds, pool stays at 100", async () => {
  // fill pool to 99 distinct future events (5 per user, same pattern as global-cap test)
  for (let i = 0; i < USER_POOL_CAP - 1; i++)
    expect((await trackEvent(db, `filler-${Math.floor(i / 5)}`, tmEv(i), sgNone)).ok).toBe(true);
  // two concurrent tracks for distinct NEW events from distinct anon IDs; advisory xact lock
  // serializes the cap check so exactly one wins.
  const [a, b] = await Promise.all([
    trackEvent(db, "race-a", tmEv(900), sgNone),
    trackEvent(db, "race-b", tmEv(901), sgNone),
  ]);
  const oks = [a, b].filter((r) => r.ok).length;
  expect(oks).toBe(1);
  expect([a, b].filter((r) => !r.ok && r.reason === "global_cap")).toHaveLength(1);
  const [{ c }] = (await db.execute(sql`
    SELECT count(*)::int AS c FROM events WHERE polling_enabled AND NOT is_seed`)).rows;
  expect(Number(c)).toBe(100);
});

test("untrack: polling stays on while other watchers remain, off when last leaves", async () => {
  const r1 = await trackEvent(db, "u1", tmEv(1), sgNone) as any;
  await trackEvent(db, "u2", tmEv(1), sgNone);
  await untrackEvent(db, "u1", r1.eventId);
  let [ev] = await db.select().from(events);
  expect(ev.pollingEnabled).toBe(true);
  await untrackEvent(db, "u2", r1.eventId);
  [ev] = await db.select().from(events);
  expect(ev.pollingEnabled).toBe(false);
});
