import { beforeAll, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { events, priceSnapshots } from "../src/schema";
import { testDb } from "./helpers";

const db = testDb();

beforeAll(async () => {
  await db.execute(sql`TRUNCATE price_snapshots, watchlist_events, event_source_state, events RESTART IDENTITY CASCADE`);
});

test("same poll_bucket twice inserts exactly one row (idempotency)", async () => {
  const [ev] = await db.insert(events).values({
    name: "Test Show", startsAt: new Date(Date.now() + 86400_000),
  }).returning();
  const bucket = new Date("2026-07-13T20:00:00Z");
  const row = { eventId: ev.id, source: "seatgeek", priceLow: "94.00", priceHigh: "890.00", priceAvg: "187.00", listingCount: 312, pollBucket: bucket };
  await db.insert(priceSnapshots).values(row).onConflictDoNothing();
  await db.insert(priceSnapshots).values(row).onConflictDoNothing();
  const rows = await db.select().from(priceSnapshots);
  expect(rows).toHaveLength(1);
});

test("duplicate tm_id rejected by partial unique index", async () => {
  await db.insert(events).values({ name: "A", tmId: "tm1", startsAt: new Date() });
  await expect(
    db.insert(events).values({ name: "B", tmId: "tm1", startsAt: new Date() }),
  ).rejects.toThrow();
  // two NULL tm_ids are fine
  await db.insert(events).values({ name: "C", startsAt: new Date() });
  await db.insert(events).values({ name: "D", startsAt: new Date() });
});
