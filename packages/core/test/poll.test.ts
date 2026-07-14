import { beforeEach, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { claimDueRows, runPollCycle } from "../src/poll";
import { events, eventSourceState, priceSnapshots } from "../src/schema";
import { testDb } from "./helpers";

const db = testDb();
const future = new Date(Date.now() + 7 * 86_400_000);

beforeEach(async () => {
  await db.execute(sql`TRUNCATE price_snapshots, watchlist_events, event_source_state, events RESTART IDENTITY CASCADE`);
});

async function seedEvent(over: Partial<typeof events.$inferInsert> = {}) {
  const [ev] = await db.insert(events).values({
    name: "Show", tmId: `tm-${Math.random()}`, startsAt: future,
    pollingEnabled: true, ...over,
  }).returning();
  await db.insert(eventSourceState).values({ eventId: ev.id, source: "tm" });
  return ev;
}

test("claim leases rows: second immediate claim gets nothing", async () => {
  await seedEvent();
  expect(await claimDueRows(db)).toHaveLength(1);
  expect(await claimDueRows(db)).toHaveLength(0); // leased 9 min
});

test("claim skips canceled, past-window, disabled, and cooling-down rows", async () => {
  await seedEvent({ eventStatus: "canceled" });
  await seedEvent({ startsAt: new Date(Date.now() - 2 * 86_400_000) });
  await seedEvent({ pollingEnabled: false });
  const hot = await seedEvent();
  await db.update(eventSourceState)
    .set({ errorCount: 3, lastErrorAt: new Date() })
    .where(sql`event_id = ${hot.id}`);
  expect(await claimDueRows(db)).toHaveLength(0);
});

test("cooldown expiry makes errored row claimable again", async () => {
  const ev = await seedEvent();
  await db.update(eventSourceState)
    .set({ errorCount: 3, lastErrorAt: new Date(Date.now() - 7 * 3_600_000) })
    .where(sql`event_id = ${ev.id}`);
  expect(await claimDueRows(db)).toHaveLength(1);
});

test("runPollCycle: success writes snapshot + resets error, failure increments", async () => {
  const ok = await seedEvent({ tmId: "tm-ok" });
  const bad = await seedEvent({ tmId: "tm-bad" });
  await db.update(eventSourceState).set({ errorCount: 2 }).where(sql`event_id = ${ok.id}`);
  const tm = { getEvent: vi.fn(async (id: string) =>
    id === "tm-ok" ? { tmId: id, priceLow: 79, priceHigh: 350 } : null) } as any;
  const sg = { getEventStats: vi.fn() } as any;

  const res = await runPollCycle(db, tm, sg);
  expect(res).toEqual({ polled: 1, failed: 1 });

  const snaps = await db.select().from(priceSnapshots);
  expect(snaps).toHaveLength(1);
  expect(snaps[0]).toMatchObject({ eventId: ok.id, source: "tm", priceAvg: null });

  const states = await db.select().from(eventSourceState);
  const okState = states.find((s) => s.eventId === ok.id)!;
  const badState = states.find((s) => s.eventId === bad.id)!;
  expect(okState.errorCount).toBe(0);
  expect(badState.errorCount).toBe(1);
  // TM cadence = +2h (minus nothing): next poll ~2h out, beyond the 9-min lease
  expect(okState.nextPollAt.getTime()).toBeGreaterThan(Date.now() + 100 * 60_000);
});

test("subrequest budget: 45 claimed rows -> exactly 45 fetches", async () => {
  for (let i = 0; i < 50; i++) await seedEvent();
  const tm = { getEvent: vi.fn(async () => ({ priceLow: 1, priceHigh: 2 })) } as any;
  const sg = { getEventStats: vi.fn() } as any;
  await runPollCycle(db, tm, sg);
  expect(tm.getEvent.mock.calls.length + sg.getEventStats.mock.calls.length).toBe(45);
});
