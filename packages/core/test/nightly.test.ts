import { beforeEach, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { runNightly, SEED_BUDGET, upsertTmEvent } from "../src/nightly";
import { events, eventSourceState, priceSnapshots, watchlistEvents } from "../src/schema";
import { testDb } from "./helpers";

const db = testDb();
const past = new Date(Date.now() - 3 * 86_400_000);
const future = new Date(Date.now() + 7 * 86_400_000);
const tmEv = (i: number) => ({
  tmId: `tm-${i}`, name: `Show ${i}`, artist: `Artist ${i}`, venue: "V", city: "C",
  eventTz: null, startsAt: future, artworkUrl: null, genre: null,
  priceLow: 10, priceHigh: 20, status: "onsale",
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE price_snapshots, watchlist_events, event_source_state, events RESTART IDENTITY CASCADE`);
});

test("past events: status flipped, polling off, is_seed cleared, watchlist purged", async () => {
  const [ev] = await db.insert(events).values({
    name: "Old", startsAt: past, isSeed: true, pollingEnabled: true,
  }).returning();
  await db.insert(watchlistEvents).values({ anonId: "u1", eventId: ev.id });
  const tm = { popular: vi.fn().mockResolvedValue([]) } as any;
  const sg = { searchCandidates: vi.fn().mockResolvedValue([]) } as any;
  await runNightly(db, tm, sg);
  const [updated] = await db.select().from(events);
  expect(updated).toMatchObject({ eventStatus: "past", pollingEnabled: false, isSeed: false });
  expect(await db.select().from(watchlistEvents)).toHaveLength(0);
});

test("snapshots older than 90 days deleted", async () => {
  const [ev] = await db.insert(events).values({ name: "E", startsAt: future }).returning();
  await db.insert(priceSnapshots).values([
    { eventId: ev.id, source: "tm", pollBucket: new Date(Date.now() - 91 * 86_400_000) },
    { eventId: ev.id, source: "tm", pollBucket: new Date() },
  ]);
  await runNightly(db, { popular: vi.fn().mockResolvedValue([]) } as any,
    { searchCandidates: vi.fn().mockResolvedValue([]) } as any);
  expect(await db.select().from(priceSnapshots)).toHaveLength(1);
});

test("seed refresh fills up to budget, never beyond; new seeds matched on NEXT night's retry pass", async () => {
  const tm = { popular: vi.fn().mockResolvedValue(
    Array.from({ length: SEED_BUDGET + 10 }, (_, i) => tmEv(i))) } as any;
  const sg = { searchCandidates: vi.fn().mockResolvedValue([]) } as any;
  await runNightly(db, tm, sg);
  const seeds = await db.select().from(events);
  expect(seeds).toHaveLength(SEED_BUDGET);
  expect(seeds.every((s) => s.isSeed && s.pollingEnabled)).toBe(true);
  // Seed refresh no longer matches inline — the retry pass ran BEFORE refresh over an empty DB,
  // so nothing was matched this run; these seeds get matched on the next nightly.
  expect(sg.searchCandidates).toHaveBeenCalledTimes(0);
  const tmStates = (await db.select().from(eventSourceState)).filter((s) => s.source === "tm");
  expect(tmStates).toHaveLength(SEED_BUDGET);
});

test("full seed refresh stays within the CF subrequest budget (all writes batched)", async () => {
  // Count every db statement (each = 1 CF subrequest under neon-http) + external fetches.
  let stmts = 0;
  const counting = new Proxy(db, {
    get(t: any, p) {
      const v = t[p];
      if (typeof v === "function" && ["execute", "insert", "select", "update", "delete"].includes(String(p)))
        return (...a: any[]) => { stmts++; return v.apply(t, a); };
      return v;
    },
  });
  const tm = { popular: vi.fn().mockResolvedValue(
    Array.from({ length: SEED_BUDGET + 10 }, (_, i) => tmEv(i))) } as any;
  const sg = { searchCandidates: vi.fn().mockResolvedValue([]) } as any;
  await runNightly(counting as any, tm, sg);
  const fetches = tm.popular.mock.calls.length + sg.searchCandidates.mock.calls.length;
  // Fixed cost regardless of seed count: past-lifecycle 1 + TTL 1 + retry-select 1 + seed-count 1
  //   + tm.popular 1 + existing-select 1 + batched-upsert 1 + batched-source-insert 1 = 8.
  expect(stmts + fetches).toBe(8);
  expect(stmts + fetches).toBeLessThanOrEqual(45);
  expect(await db.select().from(events)).toHaveLength(SEED_BUDGET);
});

test("seed budget counts is_seed flips, not just inserts — never exceeds budget", async () => {
  // 45 existing seeds (room = 5) + 5 existing NON-seed events that reappear in popular().
  // Flipping those 5 to is_seed must consume the budget so no new seeds are added → total 50, not 55.
  await db.insert(events).values(
    Array.from({ length: 45 }, (_, i) => ({
      tmId: `seed-${i}`, name: `Seed ${i}`, startsAt: future, isSeed: true, pollingEnabled: true,
    })));
  const nonSeed = Array.from({ length: 5 }, (_, i) => tmEv(100 + i));
  await db.insert(events).values(
    nonSeed.map((e) => ({ tmId: e.tmId, name: e.name, startsAt: future, isSeed: false })));
  // popular: the 5 non-seed events (flips) first, then 5 brand-new events.
  const popular = [...nonSeed, ...Array.from({ length: 5 }, (_, i) => tmEv(200 + i))];
  const tm = { popular: vi.fn().mockResolvedValue(popular) } as any;
  const sg = { searchCandidates: vi.fn().mockResolvedValue([]) } as any;
  await runNightly(db, tm, sg);
  const [{ count }] = (await db.execute(sql`SELECT count(*)::int AS count FROM events WHERE is_seed`)).rows as any[];
  expect(count).toBe(SEED_BUDGET);
});

test("per-event SG match failure is isolated: other events in the retry pass still run", async () => {
  // 3 polling-enabled, unmatched events for the retry pass; ev0's SG search throws.
  await db.insert(events).values([0, 1, 2].map((i) => ({
    tmId: `tm-${i}`, name: `Show ${i}`, artist: `Artist ${i}`, startsAt: future,
    isSeed: true, pollingEnabled: true,
  })));
  const tm = { popular: vi.fn().mockResolvedValue([]) } as any;
  const sg = {
    searchCandidates: vi.fn().mockImplementation((artist: string) => {
      if (artist === "Artist 0") throw new Error("network boom");
      return Promise.resolve([]);
    }),
  } as any;
  await expect(runNightly(db, tm, sg)).resolves.toBeUndefined();
  // All 3 attempted despite ev0 throwing; the throw is caught per-event, run completes.
  expect(sg.searchCandidates).toHaveBeenCalledTimes(3);
  expect(await db.select().from(events)).toHaveLength(3);
});

test("upsertTmEvent is idempotent on tm_id", async () => {
  const a = await upsertTmEvent(db, tmEv(1) as any, { isSeed: false });
  const b = await upsertTmEvent(db, tmEv(1) as any, { isSeed: false });
  expect(a).toBe(b);
  expect(await db.select().from(events)).toHaveLength(1);
});
