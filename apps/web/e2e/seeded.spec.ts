import { expect, test } from "@playwright/test";
import pg from "pg";

// These tests seed the e2e Postgres directly and never touch the TM API, so they run in CI
// without TM_API_KEY. The live-TM track flow stays in the keyed skip block in smoke.spec.ts.
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:test@localhost:5433/postgres";
const ANON = "11111111-2222-3333-4444-555555555555";

async function withDb<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

async function seedEvent(c: pg.Client): Promise<number> {
  const tmId = `e2e-seed-${Date.now()}`;
  const { rows } = await c.query(
    `INSERT INTO events (tm_id, sg_id, name, venue, starts_at, event_status, polling_enabled, is_seed)
     VALUES ($1, $2, 'E2E Seeded Show', 'Test Arena', now() + interval '30 days', 'upcoming', true, false)
     RETURNING id`, [tmId, `sg-${tmId}`]);
  const id = rows[0].id as number;
  await c.query(
    `INSERT INTO price_snapshots (event_id, source, price_low, price_high, price_avg, listing_count, poll_bucket)
     VALUES ($1,'tm',80,350,NULL,NULL, date_trunc('hour', now())),
            ($1,'seatgeek',120,600,210,42, date_trunc('hour', now()))`, [id]);
  await c.query(
    `INSERT INTO watchlist_events (anon_id, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ANON, id]);
  return id;
}

test.describe("seeded DB (no TM_API_KEY needed)", () => {
  let eventId: number;
  test.beforeAll(async () => { eventId = await withDb(seedEvent); });
  test.afterAll(async () => {
    await withDb(async (c) => {
      await c.query(`DELETE FROM price_snapshots WHERE event_id = $1`, [eventId]);
      await c.query(`DELETE FROM watchlist_events WHERE event_id = $1`, [eventId]);
      await c.query(`DELETE FROM event_source_state WHERE event_id = $1`, [eventId]);
      await c.query(`DELETE FROM events WHERE id = $1`, [eventId]);
    });
  });

  test("event page shows BOTH labeled price rows from DB snapshots", async ({ page }) => {
    await page.goto(`/event/${eventId}`);
    await expect(page.getByText("PRIMARY · TICKETMASTER")).toBeVisible();
    await expect(page.getByText("RESALE · SEATGEEK")).toBeVisible();
    await expect(page.getByText(/\$80/)).toBeVisible();      // TM face-value low
    await expect(page.getByText(/from \$120/)).toBeVisible(); // SG resale low
  });

  test("untrack via the tracking button removes the watchlist row", async ({ page, context }) => {
    await context.addCookies([{ name: "rhino_anon", value: ANON, url: "http://localhost:3100" }]);
    await page.goto(`/event/${eventId}`);
    const untrack = page.getByRole("button", { name: /Tracking — tap to untrack/ });
    await expect(untrack).toBeVisible();
    await untrack.click();
    await expect(page.getByRole("button", { name: /Track this event/ })).toBeVisible();
    const remaining = await withDb((c) => c.query(
      `SELECT 1 FROM watchlist_events WHERE anon_id = $1 AND event_id = $2`, [ANON, eventId]));
    expect(remaining.rowCount).toBe(0);
  });
});
