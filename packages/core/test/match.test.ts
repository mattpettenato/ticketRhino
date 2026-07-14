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

test("score at exactly the 0.8 threshold matches (boundary is inclusive)", () => {
  // artist 1·0.5 + venue 1·0.3 + date 0 (exactly +1 day) = 0.8
  const evb = { artist: "SZA", name: "SZA Tour", venue: "MSG", startsAt: starts };
  const c = cand({ title: "SZA", venue: "MSG", startsAt: new Date("2026-08-22T20:00:00Z") });
  expect(scoreCandidate(evb, c)).toBeCloseTo(0.8, 10);
  expect(scoreCandidate(evb, c)).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
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

test("matchSeatGeek links at exactly the threshold", async () => {
  const [row] = await db.insert(events).values({
    artist: "SZA", name: "SZA Tour", venue: "MSG", tmId: "tmb", startsAt: starts,
  }).returning();
  const c = cand({ title: "SZA", venue: "MSG", startsAt: new Date("2026-08-22T20:00:00Z") });
  const sg = { searchCandidates: vi.fn().mockResolvedValue([c]) } as any;
  expect(await matchSeatGeek(db, row.id, sg)).toBe(true);
});

test("matchSeatGeek never clobbers a manual/exact link", async () => {
  const [row] = await db.insert(events).values({
    ...ev, tmId: "tm1", startsAt: starts, sgId: "manual-99", matchMethod: "manual",
  }).returning();
  const sg = { searchCandidates: vi.fn().mockResolvedValue([cand({ sgId: "55" })]) } as any;
  await matchSeatGeek(db, row.id, sg);
  const [after] = await db.select().from(events);
  expect(after.sgId).toBe("manual-99");
  expect(after.matchMethod).toBe("manual");
  expect(sg.searchCandidates).not.toHaveBeenCalled(); // early-out on an existing sg link
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
