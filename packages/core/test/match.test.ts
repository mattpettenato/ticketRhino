import { beforeEach, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { MATCH_THRESHOLD, matchSeatGeek, scoreCandidate } from "../src/match";
import { events, eventSourceState } from "../src/schema";
import { testDb } from "./helpers";

const db = testDb();
const starts = new Date("2026-08-21T20:00:00Z");
const ev = { artist: "SZA", name: "SZA — SOS Tour", venue: "Madison Square Garden", startsAt: starts };
const cand = (over: object) => ({
  sgId: "55", title: "SZA", venue: "Madison Square Garden", startsAt: starts,
  stats: { sgId: "55", priceLow: 94, priceAvg: 187, priceHigh: 890, listingCount: 312 }, ...over,
});

test("exact artist+venue+date scores >= threshold", () => {
  expect(scoreCandidate(ev, cand({}))).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
});

test("wrong venue and shifted date scores below threshold", () => {
  const c = cand({ venue: "Barclays Center", startsAt: new Date("2026-08-23T20:00:00Z") });
  expect(scoreCandidate(ev, c)).toBeLessThan(MATCH_THRESHOLD);
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE price_snapshots, watchlist_events, event_source_state, events RESTART IDENTITY CASCADE`);
});

test("matchSeatGeek links and creates seatgeek source row", async () => {
  const [row] = await db.insert(events).values({ ...ev, tmId: "tm1", startsAt: starts }).returning();
  const sg = { searchCandidates: vi.fn().mockResolvedValue([cand({})]) } as any;
  expect(await matchSeatGeek(db, row.id, sg)).toBe(true);
  const [updated] = await db.select().from(events);
  expect(updated.sgId).toBe("55");
  expect(updated.matchMethod).toBe("fuzzy");
  const states = await db.select().from(eventSourceState);
  expect(states).toEqual([expect.objectContaining({ eventId: row.id, source: "seatgeek" })]);
});

test("no candidates: sets matched_at, returns false, no source row", async () => {
  const [row] = await db.insert(events).values({ ...ev, tmId: "tm1", startsAt: starts }).returning();
  const sg = { searchCandidates: vi.fn().mockResolvedValue([]) } as any;
  expect(await matchSeatGeek(db, row.id, sg)).toBe(false);
  const [updated] = await db.select().from(events);
  expect(updated.matchedAt).not.toBeNull();
  expect(updated.sgId).toBeNull();
  expect(await db.select().from(eventSourceState)).toHaveLength(0);
});
