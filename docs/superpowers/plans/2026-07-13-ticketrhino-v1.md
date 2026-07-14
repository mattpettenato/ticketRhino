# TicketRhino V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the V1 ticket-price aggregator from `docs/superpowers/specs/2026-07-13-ticketrhino-v1-design.md`: Next.js dark UI on Vercel + Neon Postgres + Cloudflare Worker poller collecting TM/SeatGeek price snapshots.

**Architecture:** pnpm monorepo. One shared package (`packages/core`) holds the Drizzle schema, DB clients, API clients, matcher, signals, track/poll/nightly logic. `apps/worker` is a thin Cloudflare cron wrapper; `apps/web` is Next.js App Router consuming core. Poller uses lease-claim + two batched writes to stay ≤48 subrequests/run.

**Tech Stack:** TypeScript, pnpm workspaces, Drizzle ORM, `@neondatabase/serverless` (HTTP driver in worker; WebSocket Pool for the Track transaction in web), Next.js 15 App Router, Tailwind v4, vitest, Playwright, wrangler.

## Global Constraints

- $0/month: Vercel Hobby, Neon free, Cloudflare Workers free. Non-commercial only; no ads/payments.
- CF Worker budget per cron run: 1 claim + ≤45 API fetches + 2 batched DB writes = **48 ≤ 50 subrequests**. Never write per-row.
- Caps: 150 polled events global = 50 seed + 100 user; 20 per anon UUID. Page views NEVER mutate the polling set.
- Cadence: TM every 2h, SeatGeek every 1h, via `next_poll_at`. Lease = 9 minutes. Error: 3 fails → 6h cooldown; reset to 0 on success.
- Price labels verbatim: `PRIMARY · TICKETMASTER` and `RESALE · SEATGEEK`. Never a combined "best price winner".
- Signals computed on SeatGeek `price_low` only, rolling UTC windows: week signal needs ≥7d data, 30-day-low needs ≥14d, 24h delta needs ≥2 buckets ≥20h apart.
- TM attribution + logo in footer. `noindex` on `/event/*`, robots.txt disallow.
- All upstream API calls server-side. Secrets only in Vercel/CF env: `DATABASE_URL`, `TM_API_KEY` (both), `SG_CLIENT_ID` (worker only).
- V1 US-only: every TM Discovery call includes `countryCode=US`. Currency stored, always 'USD'.
- Match auto-link threshold: `match_confidence >= 0.8`. `manual`/`exact_id` never overwritten by `fuzzy`.

---

### Task 1: Monorepo scaffold + GitHub repo

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.github/workflows/ci.yml`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/test/smoke.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: workspace where `pnpm -r test` and `pnpm -r typecheck` run green; `@ticketrhino/core` importable by later tasks.

- [ ] **Step 1: Write workspace config**

`package.json`:
```json
{
  "name": "ticketrhino",
  "private": true,
  "scripts": {
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  },
  "packageManager": "pnpm@9.15.0"
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

Append to `.gitignore`:
```
node_modules/
.next/
dist/
.wrangler/
*.local
```

- [ ] **Step 2: Create packages/core**

`packages/core/package.json`:
```json
{
  "name": "@ticketrhino/core",
  "version": "0.0.1",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@neondatabase/serverless": "^1.0.0",
    "drizzle-orm": "^0.44.0"
  },
  "devDependencies": {
    "drizzle-kit": "^0.31.0",
    "typescript": "^5.8.0",
    "vitest": "^3.2.0"
  }
}
```

`packages/core/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`packages/core/src/index.ts`:
```ts
export const CORE_VERSION = "0.0.1";
```

`packages/core/test/smoke.test.ts`:
```ts
import { expect, test } from "vitest";
import { CORE_VERSION } from "../src/index";

test("core package loads", () => {
  expect(CORE_VERSION).toBe("0.0.1");
});
```

- [ ] **Step 3: Install and verify**

Run: `pnpm install && pnpm test`
Expected: 1 test passed.

- [ ] **Step 4: CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
```

- [ ] **Step 5: Commit + create public GitHub repo**

```bash
git add -A && git commit -m "chore: pnpm monorepo scaffold with core package and CI"
gh repo create ticketRhino --public --source . --push
```
If `gh` auth fails with repo-not-found/404: run `chk update`, retry. Repo must land on Matt's personal account — verify with `gh repo view --json owner`.

---

### Task 2: Drizzle schema + migrations + idempotency test

**Files:**
- Create: `packages/core/src/schema.ts`, `packages/core/src/db.ts`, `packages/core/drizzle.config.ts`
- Create: `packages/core/test/helpers.ts`, `packages/core/test/schema.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: tables `events`, `eventSourceState`, `watchlistEvents`, `priceSnapshots` (exact columns below); `dbHttp(url)` → drizzle over neon-http; `dbPool(url)` → drizzle over neon WebSocket Pool (supports interactive transactions); `test/helpers.ts` exports `testDb()` returning a drizzle client against local docker Postgres.

- [ ] **Step 1: Write schema**

`packages/core/src/schema.ts`:
```ts
import {
  bigserial, boolean, char, index, integer, numeric, pgTable, primaryKey,
  real, serial, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const events = pgTable("events", {
  id: serial("id").primaryKey(),
  tmId: text("tm_id"),
  sgId: text("sg_id"),
  name: text("name").notNull(),
  artist: text("artist"),
  venue: text("venue"),
  city: text("city"),
  eventTz: text("event_tz"), // IANA tz, DISPLAY ONLY — all signal windows are rolling UTC
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  eventStatus: text("event_status").notNull().default("upcoming"), // upcoming|rescheduled|canceled|past
  artworkUrl: text("artwork_url"),
  genre: text("genre"),
  matchConfidence: real("match_confidence"),
  matchMethod: text("match_method"), // exact_id | fuzzy | manual
  matchedAt: timestamp("matched_at", { withTimezone: true }),
  isSeed: boolean("is_seed").notNull().default(false),
  pollingEnabled: boolean("polling_enabled").notNull().default(false), // invariant: is_seed OR watchers > 0
  trackedAt: timestamp("tracked_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("events_tm_id_uq").on(t.tmId).where(sql`tm_id IS NOT NULL`),
  uniqueIndex("events_sg_id_uq").on(t.sgId).where(sql`sg_id IS NOT NULL`),
  index("events_poll_idx").on(t.pollingEnabled, t.startsAt),
]);

export const eventSourceState = pgTable("event_source_state", {
  eventId: integer("event_id").notNull().references(() => events.id),
  source: text("source").notNull(), // tm | seatgeek
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  nextPollAt: timestamp("next_poll_at", { withTimezone: true }).notNull().defaultNow(),
  errorCount: integer("error_count").notNull().default(0),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.eventId, t.source] }),
  index("ess_next_poll_idx").on(t.nextPollAt),
]);

export const watchlistEvents = pgTable("watchlist_events", {
  anonId: text("anon_id").notNull(),
  eventId: integer("event_id").notNull().references(() => events.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.anonId, t.eventId] })]);

export const priceSnapshots = pgTable("price_snapshots", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  eventId: integer("event_id").notNull().references(() => events.id),
  source: text("source").notNull(),
  priceLow: numeric("price_low", { precision: 10, scale: 2 }),
  priceHigh: numeric("price_high", { precision: 10, scale: 2 }),
  priceAvg: numeric("price_avg", { precision: 10, scale: 2 }), // resale only; TM rows NULL
  listingCount: integer("listing_count"), // resale only
  currency: char("currency", { length: 3 }).notNull().default("USD"),
  pollBucket: timestamp("poll_bucket", { withTimezone: true }).notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("snap_idem_uq").on(t.eventId, t.source, t.pollBucket),
  index("snap_bucket_idx").on(t.pollBucket),
  index("snap_event_bucket_idx").on(t.eventId, t.pollBucket.desc()),
]);
```

- [ ] **Step 2: Write db client factories**

`packages/core/src/db.ts`:
```ts
import { neon, Pool } from "@neondatabase/serverless";
import { drizzle as drizzleHttp } from "drizzle-orm/neon-http";
import { drizzle as drizzlePool } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

// Worker + web reads: one HTTP subrequest per statement, no sessions.
export function dbHttp(url: string) {
  return drizzleHttp(neon(url), { schema });
}

// Web Track transaction only: WebSocket pool supports interactive transactions.
export function dbPool(url: string) {
  return drizzlePool(new Pool({ connectionString: url }), { schema });
}
```

`packages/core/drizzle.config.ts`:
```ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

Re-export from `packages/core/src/index.ts`:
```ts
export const CORE_VERSION = "0.0.1";
export * as schema from "./schema";
export { dbHttp, dbPool } from "./db";
```

- [ ] **Step 3: Local test DB helper**

`packages/core/test/helpers.ts`:
```ts
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/schema";

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:test@localhost:5433/postgres";

export function testDb() {
  return drizzle(TEST_DB_URL, { schema });
}
```

Add `pg` + `@types/pg` to core devDependencies: `pnpm --filter @ticketrhino/core add -D pg @types/pg`

- [ ] **Step 4: Write failing idempotency test**

`packages/core/test/schema.test.ts`:
```ts
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
```

- [ ] **Step 5: Run test to verify it fails**

```bash
docker run -d --name trhino-pg -e POSTGRES_PASSWORD=test -p 5433:5432 postgres:16
pnpm --filter @ticketrhino/core test
```
Expected: FAIL — relations do not exist (no migration applied yet).

- [ ] **Step 6: Generate + apply migration, re-run**

```bash
cd packages/core
DATABASE_URL=postgresql://postgres:test@localhost:5433/postgres pnpm drizzle-kit generate
DATABASE_URL=postgresql://postgres:test@localhost:5433/postgres pnpm drizzle-kit migrate
cd ../.. && pnpm --filter @ticketrhino/core test
```
Expected: PASS (both tests).

- [ ] **Step 7: Commit**

```bash
git add packages/core && git commit -m "feat(core): drizzle schema, db clients, idempotent snapshot key"
```

---

### Task 3: Signals module (pure math)

**Files:**
- Create: `packages/core/src/signals.ts`, `packages/core/test/signals.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./signals"`)

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  ```ts
  type SnapPoint = { pollBucket: Date; priceLow: number };
  function weekDelta(points: SnapPoint[], now: Date): number | null;      // fraction, e.g. -0.12; null if <7d span
  function isLowest30d(points: SnapPoint[], now: Date): boolean | null;    // null if <14d span
  function delta24h(points: SnapPoint[], now: Date): number | null;        // null unless ≥2 buckets ≥20h apart in window
  function historySpanDays(points: SnapPoint[]): number;
  ```
  `points` are ascending by `pollBucket`, resale (seatgeek) rows only.

- [ ] **Step 1: Write failing tests**

`packages/core/test/signals.test.ts`:
```ts
import { expect, test } from "vitest";
import { delta24h, isLowest30d, weekDelta } from "../src/signals";

const now = new Date("2026-07-13T20:00:00Z");
const h = 3600_000;
const pt = (hoursAgo: number, priceLow: number) => ({
  pollBucket: new Date(now.getTime() - hoursAgo * h), priceLow,
});

test("weekDelta: needs >=7 days of data", () => {
  expect(weekDelta([pt(24, 100), pt(1, 90)], now)).toBeNull();
});

test("weekDelta: (latest - low_7d_ago) / low_7d_ago", () => {
  const points = [pt(24 * 8, 100), pt(24 * 7, 100), pt(24 * 3, 95), pt(1, 88)];
  expect(weekDelta(points, now)).toBeCloseTo((88 - 100) / 100);
});

test("isLowest30d: null under 14 days of history", () => {
  expect(isLowest30d([pt(24 * 10, 100), pt(1, 80)], now)).toBeNull();
});

test("isLowest30d: true only when latest <= min of window", () => {
  const base = [pt(24 * 20, 100), pt(24 * 10, 85)];
  expect(isLowest30d([...base, pt(1, 80)], now)).toBe(true);
  expect(isLowest30d([...base, pt(1, 90)], now)).toBe(false);
});

test("delta24h: null without 2 buckets >=20h apart in window", () => {
  expect(delta24h([pt(3, 100), pt(1, 90)], now)).toBeNull();
});

test("delta24h: (latest - oldest_in_window) / oldest", () => {
  expect(delta24h([pt(23, 100), pt(1, 88)], now)).toBeCloseTo(-0.12);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ticketrhino/core test signals`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/core/src/signals.ts`:
```ts
// All windows are rolling UTC intervals from `now` (spec §7). Resale price_low only.
export type SnapPoint = { pollBucket: Date; priceLow: number };

const DAY = 86_400_000;

export function historySpanDays(points: SnapPoint[]): number {
  if (points.length < 2) return 0;
  return (points[points.length - 1].pollBucket.getTime() - points[0].pollBucket.getTime()) / DAY;
}

function inWindow(points: SnapPoint[], now: Date, days: number): SnapPoint[] {
  const cutoff = now.getTime() - days * DAY;
  return points.filter((p) => p.pollBucket.getTime() >= cutoff);
}

export function weekDelta(points: SnapPoint[], now: Date): number | null {
  if (historySpanDays(points) < 7) return null;
  const latest = points[points.length - 1];
  const target = now.getTime() - 7 * DAY;
  // bucket closest to now - 7d
  const ref = points.reduce((best, p) =>
    Math.abs(p.pollBucket.getTime() - target) < Math.abs(best.pollBucket.getTime() - target) ? p : best,
  );
  if (ref.priceLow === 0) return null;
  return (latest.priceLow - ref.priceLow) / ref.priceLow;
}

export function isLowest30d(points: SnapPoint[], now: Date): boolean | null {
  if (historySpanDays(points) < 14) return null;
  const window = inWindow(points, now, 30);
  const latest = window[window.length - 1];
  return latest.priceLow <= Math.min(...window.map((p) => p.priceLow));
}

export function delta24h(points: SnapPoint[], now: Date): number | null {
  const window = inWindow(points, now, 1);
  if (window.length < 2) return null;
  const oldest = window[0];
  const latest = window[window.length - 1];
  if (latest.pollBucket.getTime() - oldest.pollBucket.getTime() < 20 * 3_600_000) return null;
  if (oldest.priceLow === 0) return null;
  return (latest.priceLow - oldest.priceLow) / oldest.priceLow;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @ticketrhino/core test signals`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/core && git commit -m "feat(core): data-gated price signal math"
```

---

### Task 4: TM + SeatGeek API clients with backoff

**Files:**
- Create: `packages/core/src/tm.ts`, `packages/core/src/sg.ts`, `packages/core/src/backoff.ts`
- Create: `packages/core/test/clients.test.ts`
- Modify: `packages/core/src/index.ts` (`export * from "./tm"; export * from "./sg";`)

**Interfaces:**
- Produces:
  ```ts
  type TmEvent = { tmId: string; name: string; artist: string | null; venue: string | null;
    city: string | null; eventTz: string | null; startsAt: Date; artworkUrl: string | null;
    genre: string | null; priceLow: number | null; priceHigh: number | null; status: string };
  type SgStats = { sgId: string; priceLow: number | null; priceAvg: number | null;
    priceHigh: number | null; listingCount: number | null };
  type SgCandidate = { sgId: string; title: string; venue: string | null; startsAt: Date;
    stats: SgStats };
  tmClient(apiKey: string, fetchFn?: typeof fetch) => {
    getEvent(tmId): Promise<TmEvent | null>;
    search(keyword): Promise<TmEvent[]>;          // countryCode=US always
    popular(size: number): Promise<TmEvent[]>;    // sorted by relevance/popularity, US
  }
  sgClient(clientId: string, fetchFn?: typeof fetch) => {
    getEventStats(sgId): Promise<SgStats | null>;
    searchCandidates(artistOrName: string, around: Date): Promise<SgCandidate[]>; // ±1 day window
  }
  fetchWithBackoff(fetchFn, url, opts?, tries = 3): Promise<Response>; // retries 429/5xx, exp backoff 500ms base
  ```
  All parsing failures return null / skip the item — never throw partial garbage into callers (spec §9).

- [ ] **Step 1: Write failing tests (mocked fetch)**

`packages/core/test/clients.test.ts`:
```ts
import { expect, test, vi } from "vitest";
import { fetchWithBackoff } from "../src/backoff";
import { tmClient } from "../src/tm";
import { sgClient } from "../src/sg";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("fetchWithBackoff retries 429 then succeeds", async () => {
  const f = vi.fn()
    .mockResolvedValueOnce(json({}, 429))
    .mockResolvedValueOnce(json({ ok: true }));
  const res = await fetchWithBackoff(f, "https://x", undefined, 3, 1);
  expect(res.status).toBe(200);
  expect(f).toHaveBeenCalledTimes(2);
});

test("fetchWithBackoff gives up after tries and returns last response", async () => {
  const f = vi.fn().mockResolvedValue(json({}, 503));
  const res = await fetchWithBackoff(f, "https://x", undefined, 3, 1);
  expect(res.status).toBe(503);
  expect(f).toHaveBeenCalledTimes(3);
});

test("tm search parses Discovery payload and always sends countryCode=US", async () => {
  const f = vi.fn().mockResolvedValue(json({
    _embedded: { events: [{
      id: "tm123", name: "SZA — SOS Tour",
      dates: { start: { dateTime: "2026-08-21T20:00:00Z" }, timezone: "America/New_York", status: { code: "onsale" } },
      priceRanges: [{ min: 79, max: 350 }],
      classifications: [{ genre: { name: "R&B" } }],
      images: [{ url: "https://img/1.jpg", width: 1024 }],
      _embedded: { venues: [{ name: "Madison Square Garden", city: { name: "New York" } }],
                   attractions: [{ name: "SZA" }] },
    }] },
  }));
  const tm = tmClient("KEY", f);
  const [ev] = await tm.search("sza");
  expect(f.mock.calls[0][0]).toContain("countryCode=US");
  expect(ev).toMatchObject({ tmId: "tm123", artist: "SZA", venue: "Madison Square Garden",
    priceLow: 79, priceHigh: 350, genre: "R&B" });
});

test("sg getEventStats maps stats fields, null on 404", async () => {
  const f = vi.fn()
    .mockResolvedValueOnce(json({ id: 55, stats: { lowest_price: 94, average_price: 187, highest_price: 890, listing_count: 312 } }))
    .mockResolvedValueOnce(json({}, 404));
  const sg = sgClient("CID", f);
  expect(await sg.getEventStats("55")).toMatchObject({ sgId: "55", priceLow: 94, priceAvg: 187, priceHigh: 890, listingCount: 312 });
  expect(await sg.getEventStats("55")).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ticketrhino/core test clients`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/core/src/backoff.ts`:
```ts
export async function fetchWithBackoff(
  fetchFn: typeof fetch, url: string, opts?: RequestInit, tries = 3, baseMs = 500,
): Promise<Response> {
  let res!: Response;
  for (let i = 0; i < tries; i++) {
    res = await fetchFn(url, opts);
    if (res.status !== 429 && res.status < 500) return res;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
  }
  return res;
}
```

`packages/core/src/tm.ts`:
```ts
import { fetchWithBackoff } from "./backoff";

export type TmEvent = {
  tmId: string; name: string; artist: string | null; venue: string | null;
  city: string | null; eventTz: string | null; startsAt: Date; artworkUrl: string | null;
  genre: string | null; priceLow: number | null; priceHigh: number | null; status: string;
};

const BASE = "https://app.ticketmaster.com/discovery/v2";

function parseEvent(e: any): TmEvent | null {
  const dateTime = e?.dates?.start?.dateTime;
  if (!e?.id || !e?.name || !dateTime) return null; // skip garbage, never throw (spec §9)
  const venue = e._embedded?.venues?.[0];
  const img = (e.images ?? []).sort((a: any, b: any) => (b.width ?? 0) - (a.width ?? 0))[0];
  return {
    tmId: e.id, name: e.name,
    artist: e._embedded?.attractions?.[0]?.name ?? null,
    venue: venue?.name ?? null, city: venue?.city?.name ?? null,
    eventTz: e.dates?.timezone ?? null, startsAt: new Date(dateTime),
    artworkUrl: img?.url ?? null,
    genre: e.classifications?.[0]?.genre?.name ?? null,
    priceLow: e.priceRanges?.[0]?.min ?? null, priceHigh: e.priceRanges?.[0]?.max ?? null,
    status: e.dates?.status?.code ?? "onsale",
  };
}

export function tmClient(apiKey: string, fetchFn: typeof fetch = fetch) {
  const get = async (path: string, params: Record<string, string>) => {
    const qs = new URLSearchParams({ ...params, countryCode: "US", apikey: apiKey });
    const res = await fetchWithBackoff(fetchFn, `${BASE}${path}?${qs}`);
    if (!res.ok) return null;
    return res.json() as Promise<any>;
  };
  return {
    async getEvent(tmId: string): Promise<TmEvent | null> {
      const body = await get(`/events/${encodeURIComponent(tmId)}.json`, {});
      return body ? parseEvent(body) : null;
    },
    async search(keyword: string): Promise<TmEvent[]> {
      const body = await get("/events.json", { keyword, size: "20", sort: "relevance,desc" });
      return (body?._embedded?.events ?? []).map(parseEvent).filter(Boolean) as TmEvent[];
    },
    async popular(size: number): Promise<TmEvent[]> {
      const body = await get("/events.json", { size: String(size), sort: "relevance,desc" });
      return (body?._embedded?.events ?? []).map(parseEvent).filter(Boolean) as TmEvent[];
    },
  };
}
```

`packages/core/src/sg.ts`:
```ts
import { fetchWithBackoff } from "./backoff";

export type SgStats = {
  sgId: string; priceLow: number | null; priceAvg: number | null;
  priceHigh: number | null; listingCount: number | null;
};
export type SgCandidate = { sgId: string; title: string; venue: string | null; startsAt: Date; stats: SgStats };

const BASE = "https://api.seatgeek.com/2";

function parseStats(e: any): SgStats {
  return {
    sgId: String(e.id),
    priceLow: e.stats?.lowest_price ?? null,
    priceAvg: e.stats?.average_price ?? null,
    priceHigh: e.stats?.highest_price ?? null,
    listingCount: e.stats?.listing_count ?? null,
  };
}

export function sgClient(clientId: string, fetchFn: typeof fetch = fetch) {
  const get = async (path: string, params: Record<string, string>) => {
    const qs = new URLSearchParams({ ...params, client_id: clientId });
    const res = await fetchWithBackoff(fetchFn, `${BASE}${path}?${qs}`);
    if (!res.ok) return null;
    return res.json() as Promise<any>;
  };
  return {
    async getEventStats(sgId: string): Promise<SgStats | null> {
      const body = await get(`/events/${encodeURIComponent(sgId)}`, {});
      return body?.id ? parseStats(body) : null;
    },
    async searchCandidates(artistOrName: string, around: Date): Promise<SgCandidate[]> {
      const day = 86_400_000;
      const gte = new Date(around.getTime() - day).toISOString().slice(0, 10);
      const lte = new Date(around.getTime() + day).toISOString().slice(0, 10);
      const body = await get("/events", {
        q: artistOrName, "datetime_utc.gte": gte, "datetime_utc.lte": lte, per_page: "10",
      });
      return (body?.events ?? [])
        .filter((e: any) => e?.id && e?.datetime_utc)
        .map((e: any) => ({
          sgId: String(e.id), title: e.title ?? "",
          venue: e.venue?.name ?? null, startsAt: new Date(e.datetime_utc + "Z"),
          stats: parseStats(e),
        }));
    },
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @ticketrhino/core test clients`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/core && git commit -m "feat(core): TM Discovery + SeatGeek clients with bounded backoff"
```

---

### Task 5: Cross-source matcher

**Files:**
- Create: `packages/core/src/match.ts`, `packages/core/test/match.test.ts`
- Modify: `packages/core/src/index.ts` (`export * from "./match"`)

**Interfaces:**
- Consumes: `SgCandidate` (Task 4), drizzle db (Task 2 — any of testDb/dbHttp/dbPool).
- Produces:
  ```ts
  function scoreCandidate(ev: { artist: string | null; name: string; venue: string | null; startsAt: Date }, cand: SgCandidate): number; // 0..1
  const MATCH_THRESHOLD = 0.8;
  async function matchSeatGeek(db, eventId: number, sg: ReturnType<typeof sgClient>): Promise<boolean>;
  // fetches candidates, scores, on >=0.8: sets sg_id/match_* fields, inserts ('seatgeek') source-state row.
  // ALWAYS sets matched_at = now() (drives nightly retry). Never overwrites match_method manual/exact_id.
  // Returns true if linked.
  ```

- [ ] **Step 1: Write failing tests**

`packages/core/test/match.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ticketrhino/core test match`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/core/src/match.ts`:
```ts
import { and, eq, isNull, or } from "drizzle-orm";
import { events, eventSourceState } from "./schema";
import type { SgCandidate, sgClient } from "./sg";

export const MATCH_THRESHOLD = 0.8;

const norm = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(norm(a).split(/\s+/).filter(Boolean));
  const tb = new Set(norm(b).split(/\s+/).filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.max(ta.size, tb.size);
}

// weights: artist 0.5, venue 0.3, date 0.2 (±1 day linear falloff)
export function scoreCandidate(
  ev: { artist: string | null; name: string; venue: string | null; startsAt: Date },
  cand: SgCandidate,
): number {
  const artistScore = Math.max(
    tokenOverlap(ev.artist ?? ev.name, cand.title),
    tokenOverlap(ev.name, cand.title),
  );
  const venueScore = ev.venue && cand.venue ? tokenOverlap(ev.venue, cand.venue) : 0;
  const dayDiff = Math.abs(ev.startsAt.getTime() - cand.startsAt.getTime()) / 86_400_000;
  const dateScore = Math.max(0, 1 - dayDiff); // 0 at ±1 day
  return 0.5 * artistScore + 0.3 * venueScore + 0.2 * dateScore;
}

export async function matchSeatGeek(
  db: any, eventId: number, sg: ReturnType<typeof sgClient>,
): Promise<boolean> {
  const [ev] = await db.select().from(events).where(eq(events.id, eventId));
  if (!ev || ev.sgId) return !!ev?.sgId;
  const candidates = await sg.searchCandidates(ev.artist ?? ev.name, ev.startsAt);
  const scored = candidates
    .map((c: SgCandidate) => ({ c, score: scoreCandidate(ev, c) }))
    .sort((a: any, b: any) => b.score - a.score)[0];
  const now = new Date();
  if (scored && scored.score >= MATCH_THRESHOLD) {
    await db.update(events).set({
      sgId: scored.c.sgId, matchConfidence: scored.score, matchMethod: "fuzzy", matchedAt: now,
    }).where(and(eq(events.id, eventId),
      or(isNull(events.matchMethod), eq(events.matchMethod, "fuzzy")))); // never clobber manual/exact_id
    await db.insert(eventSourceState)
      .values({ eventId, source: "seatgeek" }).onConflictDoNothing();
    return true;
  }
  await db.update(events).set({ matchedAt: now }).where(eq(events.id, eventId));
  return false;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @ticketrhino/core test match`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/core && git commit -m "feat(core): SG cross-source matcher, 0.8 auto-link threshold"
```

---

### Task 6: Poll cycle (claim → concurrent fetch → two batched writes)

**Files:**
- Create: `packages/core/src/poll.ts`, `packages/core/test/poll.test.ts`
- Modify: `packages/core/src/index.ts` (`export * from "./poll"`)

**Interfaces:**
- Consumes: `tmClient`, `sgClient` (Task 4); schema (Task 2).
- Produces:
  ```ts
  const CLAIM_LIMIT = 45; const LEASE_MINUTES = 9;
  type ClaimedRow = { eventId: number; source: "tm" | "seatgeek"; tmId: string | null; sgId: string | null };
  async function claimDueRows(db): Promise<ClaimedRow[]>;          // one raw-SQL statement, spec §5
  async function runPollCycle(db, tm, sg, now?: Date): Promise<{ polled: number; failed: number }>;
  ```
  `runPollCycle` = 1 claim + ≤45 fetches (chunks of 10) + exactly 2 batched writes.

- [ ] **Step 1: Write failing tests**

`packages/core/test/poll.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ticketrhino/core test poll`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/core/src/poll.ts`:
```ts
import { sql } from "drizzle-orm";
import { priceSnapshots } from "./schema";
import type { tmClient } from "./tm";
import type { sgClient } from "./sg";

export const CLAIM_LIMIT = 45;   // 1 claim + 45 fetches + 2 batched writes = 48 <= 50 CF subrequests
export const LEASE_MINUTES = 9;  // lease doubles as overlap guard (spec §5)

export type ClaimedRow = { eventId: number; source: "tm" | "seatgeek"; tmId: string | null; sgId: string | null };

export async function claimDueRows(db: any): Promise<ClaimedRow[]> {
  const res = await db.execute(sql`
    UPDATE event_source_state ess SET next_poll_at = now() + interval '9 minutes'
    FROM (
      SELECT ess2.event_id, ess2.source
      FROM event_source_state ess2 JOIN events e ON e.id = ess2.event_id
      WHERE ess2.next_poll_at <= now() AND e.polling_enabled
        AND e.event_status NOT IN ('canceled','past')
        AND e.starts_at > now() - interval '24 hours'
        AND (ess2.error_count < 3 OR ess2.last_error_at < now() - interval '6 hours')
      ORDER BY ess2.next_poll_at LIMIT ${CLAIM_LIMIT} FOR UPDATE SKIP LOCKED
    ) due
    JOIN events ev ON ev.id = due.event_id
    WHERE ess.event_id = due.event_id AND ess.source = due.source
    RETURNING ess.event_id AS "eventId", ess.source, ev.tm_id AS "tmId", ev.sg_id AS "sgId"
  `);
  return res.rows as ClaimedRow[];
}

type FetchResult = ClaimedRow & {
  ok: boolean;
  priceLow?: number | null; priceHigh?: number | null;
  priceAvg?: number | null; listingCount?: number | null;
};

async function fetchOne(row: ClaimedRow, tm: ReturnType<typeof tmClient>, sg: ReturnType<typeof sgClient>): Promise<FetchResult> {
  try {
    if (row.source === "tm") {
      const ev = row.tmId ? await tm.getEvent(row.tmId) : null;
      if (ev?.priceLow == null && ev?.priceHigh == null) return { ...row, ok: false };
      return { ...row, ok: true, priceLow: ev!.priceLow, priceHigh: ev!.priceHigh, priceAvg: null, listingCount: null };
    }
    const stats = row.sgId ? await sg.getEventStats(row.sgId) : null;
    if (!stats || stats.priceLow == null) return { ...row, ok: false };
    return { ...row, ok: true, priceLow: stats.priceLow, priceHigh: stats.priceHigh, priceAvg: stats.priceAvg, listingCount: stats.listingCount };
  } catch {
    return { ...row, ok: false };
  }
}

export async function runPollCycle(
  db: any, tm: ReturnType<typeof tmClient>, sg: ReturnType<typeof sgClient>, now = new Date(),
): Promise<{ polled: number; failed: number }> {
  const claimed = await claimDueRows(db);
  if (!claimed.length) return { polled: 0, failed: 0 };

  const results: FetchResult[] = [];
  for (let i = 0; i < claimed.length; i += 10) {  // chunks of 10, concurrent within chunk
    results.push(...await Promise.all(claimed.slice(i, i + 10).map((r) => fetchOne(r, tm, sg))));
  }

  const bucket = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
  const successes = results.filter((r) => r.ok);

  // Batched write #1: all snapshots in one INSERT (spec §5 — never per-row)
  if (successes.length) {
    await db.insert(priceSnapshots).values(successes.map((r) => ({
      eventId: r.eventId, source: r.source,
      priceLow: r.priceLow != null ? String(r.priceLow) : null,
      priceHigh: r.priceHigh != null ? String(r.priceHigh) : null,
      priceAvg: r.priceAvg != null ? String(r.priceAvg) : null,
      listingCount: r.listingCount ?? null, pollBucket: bucket,
    }))).onConflictDoNothing();
  }

  // Batched write #2: one UPDATE ... FROM (VALUES ...) for all state rows
  const values = sql.join(results.map((r) => sql`(${r.eventId}, ${r.source}, ${r.ok})`), sql`, `);
  await db.execute(sql`
    UPDATE event_source_state ess SET
      last_polled_at = CASE WHEN v.ok THEN now() ELSE ess.last_polled_at END,
      next_poll_at   = now() + CASE WHEN v.source = 'tm' THEN interval '2 hours' ELSE interval '1 hour' END,
      error_count    = CASE WHEN v.ok THEN 0 ELSE ess.error_count + 1 END,
      last_error_at  = CASE WHEN v.ok THEN ess.last_error_at ELSE now() END
    FROM (VALUES ${values}) AS v(event_id, source, ok)
    WHERE ess.event_id = v.event_id AND ess.source = v.source
  `);

  return { polled: successes.length, failed: results.length - successes.length };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @ticketrhino/core test poll`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/core && git commit -m "feat(core): lease-claim poll cycle, 48-subrequest budget"
```

---

### Task 7: Nightly job (lifecycle, TTL, seed refresh, SG retry)

**Files:**
- Create: `packages/core/src/nightly.ts`, `packages/core/test/nightly.test.ts`
- Modify: `packages/core/src/index.ts` (`export * from "./nightly"`)

**Interfaces:**
- Consumes: `tmClient`, `sgClient`, `matchSeatGeek`, schema.
- Produces:
  ```ts
  const SEED_BUDGET = 50; const SG_RETRY_LIMIT = 25;
  async function upsertTmEvent(db, ev: TmEvent, opts: { isSeed: boolean }): Promise<number>; // event id; creates ('tm') source row
  async function runNightly(db, tm, sg): Promise<void>;
  ```
  `upsertTmEvent` is reused by Track (Task 9).

- [ ] **Step 1: Write failing tests**

`packages/core/test/nightly.test.ts`:
```ts
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

test("seed refresh fills up to budget, never beyond, attempts SG match per new event", async () => {
  const tm = { popular: vi.fn().mockResolvedValue(
    Array.from({ length: SEED_BUDGET + 10 }, (_, i) => tmEv(i))) } as any;
  const sg = { searchCandidates: vi.fn().mockResolvedValue([]) } as any;
  await runNightly(db, tm, sg);
  const seeds = await db.select().from(events);
  expect(seeds).toHaveLength(SEED_BUDGET);
  expect(seeds.every((s) => s.isSeed && s.pollingEnabled)).toBe(true);
  expect(sg.searchCandidates).toHaveBeenCalledTimes(SEED_BUDGET);
  const tmStates = (await db.select().from(eventSourceState)).filter((s) => s.source === "tm");
  expect(tmStates).toHaveLength(SEED_BUDGET);
});

test("upsertTmEvent is idempotent on tm_id", async () => {
  const a = await upsertTmEvent(db, tmEv(1) as any, { isSeed: false });
  const b = await upsertTmEvent(db, tmEv(1) as any, { isSeed: false });
  expect(a).toBe(b);
  expect(await db.select().from(events)).toHaveLength(1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ticketrhino/core test nightly`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/core/src/nightly.ts`:
```ts
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
      const existing = await db.select({ id: events.id }).from(events).where(eq(events.tmId, ev.tmId));
      const isNew = existing.length === 0;
      const id = await upsertTmEvent(db, ev, { isSeed: true });
      if (isNew) { added++; await matchSeatGeek(db, id, sg); }
    }
  }

  // 4. SG match retry pass: bounded, oldest attempts first
  const unmatched = (await db.execute(sql`
    SELECT id FROM events
    WHERE polling_enabled AND sg_id IS NULL
      AND (matched_at IS NULL OR matched_at < now() - interval '24 hours')
    ORDER BY matched_at NULLS FIRST LIMIT ${SG_RETRY_LIMIT}
  `)).rows as { id: number }[];
  for (const { id } of unmatched) await matchSeatGeek(db, id, sg);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @ticketrhino/core test nightly`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/core && git commit -m "feat(core): nightly lifecycle, TTL, seed refresh, bounded SG retry"
```

---

### Task 8: Track/untrack transactions

**Files:**
- Create: `packages/core/src/track.ts`, `packages/core/test/track.test.ts`
- Modify: `packages/core/src/index.ts` (`export * from "./track"`)

**Interfaces:**
- Consumes: `upsertTmEvent` (Task 7), `matchSeatGeek` (Task 5), `TmEvent` (Task 4). Requires a drizzle client that supports `db.transaction()` (Pool/node-postgres — NOT neon-http).
- Produces:
  ```ts
  const USER_POOL_CAP = 100; const PER_USER_CAP = 20;
  type TrackResult = { ok: true; eventId: number } | { ok: false; reason: "user_cap" | "global_cap" };
  async function trackEvent(db, anonId: string, tmEvent: TmEvent, sg): Promise<TrackResult>;
  async function untrackEvent(db, anonId: string, eventId: number): Promise<void>;
  ```

- [ ] **Step 1: Write failing tests**

`packages/core/test/track.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ticketrhino/core test track`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/core/src/track.ts`:
```ts
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
```

Note for implementer: `testDb()` uses node-postgres — `db.transaction`/`tx.execute` work. In web (Task 11) pass `dbPool(...)`; never `dbHttp` here.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @ticketrhino/core test track`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/core && git commit -m "feat(core): transactional track/untrack with cap + purge semantics"
```

---

### Task 9: Cloudflare Worker wrapper

**Files:**
- Create: `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/wrangler.toml`, `apps/worker/src/index.ts`, `apps/worker/test/worker.test.ts`

**Interfaces:**
- Consumes: `dbHttp`, `tmClient`, `sgClient`, `runPollCycle`, `runNightly` from `@ticketrhino/core`.
- Produces: deployed worker with crons `*/10 * * * *` (poll) and `0 5 * * *` (nightly). Env bindings: `DATABASE_URL`, `TM_API_KEY`, `SG_CLIENT_ID`.

- [ ] **Step 1: Scaffold**

`apps/worker/package.json`:
```json
{
  "name": "@ticketrhino/worker",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "deploy": "wrangler deploy",
    "dev": "wrangler dev --test-scheduled"
  },
  "dependencies": { "@ticketrhino/core": "workspace:*" },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250601.0",
    "typescript": "^5.8.0", "vitest": "^3.2.0", "wrangler": "^4.0.0"
  }
}
```

`apps/worker/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["@cloudflare/workers-types"] },
  "include": ["src", "test"] }
```

`apps/worker/wrangler.toml`:
```toml
name = "ticketrhino-poller"
main = "src/index.ts"
compatibility_date = "2026-07-01"
[triggers]
crons = ["*/10 * * * *", "0 5 * * *"]
```

- [ ] **Step 2: Write failing test (cron routing)**

`apps/worker/test/worker.test.ts`:
```ts
import { expect, test, vi } from "vitest";

vi.mock("@ticketrhino/core", async (orig) => ({
  ...(await orig()) as object,
  dbHttp: vi.fn(() => ({})),
  tmClient: vi.fn(() => ({})),
  sgClient: vi.fn(() => ({})),
  runPollCycle: vi.fn().mockResolvedValue({ polled: 1, failed: 0 }),
  runNightly: vi.fn().mockResolvedValue(undefined),
}));
import worker from "../src/index";
import { runNightly, runPollCycle } from "@ticketrhino/core";

const env = { DATABASE_URL: "postgres://x", TM_API_KEY: "k", SG_CLIENT_ID: "c" } as any;
const ctx = { waitUntil: (p: Promise<unknown>) => p } as any;

test("10-min cron runs poll cycle; 5am cron runs nightly", async () => {
  await worker.scheduled({ cron: "*/10 * * * *" } as any, env, ctx);
  expect(runPollCycle).toHaveBeenCalledTimes(1);
  await worker.scheduled({ cron: "0 5 * * *" } as any, env, ctx);
  expect(runNightly).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @ticketrhino/worker test`
Expected: FAIL — `../src/index` not found.

- [ ] **Step 4: Implement**

`apps/worker/src/index.ts`:
```ts
import { dbHttp, runNightly, runPollCycle, sgClient, tmClient } from "@ticketrhino/core";

export interface Env { DATABASE_URL: string; TM_API_KEY: string; SG_CLIENT_ID: string }

export default {
  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    const db = dbHttp(env.DATABASE_URL);
    const tm = tmClient(env.TM_API_KEY);
    const sg = sgClient(env.SG_CLIENT_ID);
    if (event.cron === "0 5 * * *") {
      await runNightly(db, tm, sg);
    } else {
      const res = await runPollCycle(db, tm, sg);
      console.log(`poll cycle: ${res.polled} ok, ${res.failed} failed`);
    }
  },
};
```

- [ ] **Step 5: Run to verify pass + typecheck**

Run: `pnpm --filter @ticketrhino/worker test && pnpm --filter @ticketrhino/worker typecheck`
Expected: 1 passed; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/worker && git commit -m "feat(worker): cron wrapper for poll cycle + nightly job"
```

---

### Task 10: Next.js scaffold + H1 Indigo Emerald theme

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/next.config.ts`, `apps/web/postcss.config.mjs`
- Create: `apps/web/src/app/globals.css`, `apps/web/src/app/layout.tsx`, `apps/web/src/app/page.tsx` (placeholder), `apps/web/public/robots.txt`
- Create: `apps/web/src/lib/env.ts`

**Interfaces:**
- Produces: running Next.js app with theme utilities other tasks use: CSS classes `.glass-card`, `.label-caps`, `.price-mono`, `.headline-serif`; `env()` helper returning `{ DATABASE_URL, TM_API_KEY, SG_CLIENT_ID }`.

- [ ] **Step 1: Scaffold app**

```bash
pnpm create next-app@latest apps/web --ts --app --tailwind --src-dir --no-eslint --import-alias "@/*" --use-pnpm
pnpm --filter web add @ticketrhino/core@workspace:*
```
Rename the generated package name in `apps/web/package.json` to `"web"`, add `"typecheck": "tsc --noEmit"` script and `"test": "echo 'no unit tests — Playwright in Task 13'"`.

- [ ] **Step 2: Theme**

`apps/web/src/app/globals.css`:
```css
@import "tailwindcss";

:root {
  --bg-from: #1e1b4b;
  --bg-to: #0c0a1d;
  --emerald: #34d399;
  --red: #f87171;
  --peri: #818cf8;
  --peri-light: #c7d2fe;
}

body {
  background: radial-gradient(120% 120% at 20% 0%, var(--bg-from) 0%, var(--bg-to) 60%);
  min-height: 100vh;
  color: #e5e7eb;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.glass-card {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 1rem;
  backdrop-filter: blur(10px);
}
.headline-serif { font-family: Georgia, "Times New Roman", serif; font-style: italic; }
.price-mono { font-family: "SF Mono", ui-monospace, Menlo, monospace; }
.label-caps { font-size: 0.625rem; letter-spacing: 0.15em; color: var(--peri-light); font-weight: 600; }
.glow-emerald { box-shadow: 0 0 14px rgba(52, 211, 153, 0.4); }
```

`apps/web/src/app/layout.tsx`:
```tsx
import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = { title: "TicketRhino", description: "Know when to buy." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="mx-auto max-w-2xl px-4 pb-16">
        <header className="flex items-center justify-between py-5">
          <Link href="/" className="text-lg font-black tracking-tight text-white">
            🦏 Ticket<span style={{ color: "var(--emerald)" }}>Rhino</span>
          </Link>
          <Link href="/watchlist" className="text-sm" style={{ color: "var(--peri)" }}>Watchlist</Link>
        </header>
        {children}
        <footer className="mt-16 text-center text-xs text-gray-500">
          Event data by{" "}
          <a href="https://www.ticketmaster.com" className="underline">Ticketmaster</a> · resale stats by{" "}
          <a href="https://seatgeek.com" className="underline">SeatGeek</a>. Non-commercial project.
        </footer>
      </body>
    </html>
  );
}
```

`apps/web/src/lib/env.ts`:
```ts
export function env() {
  const { DATABASE_URL, TM_API_KEY, SG_CLIENT_ID } = process.env;
  if (!DATABASE_URL || !TM_API_KEY) throw new Error("Missing required env");
  return { DATABASE_URL, TM_API_KEY, SG_CLIENT_ID: SG_CLIENT_ID ?? "" };
}
```

`apps/web/public/robots.txt`:
```
User-agent: *
Disallow: /event/
```

`apps/web/src/app/page.tsx` placeholder:
```tsx
export default function Home() {
  return <p className="label-caps">TRENDING — coming in Task 12</p>;
}
```

- [ ] **Step 3: Verify build**

Run: `pnpm --filter web build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/web pnpm-lock.yaml && git commit -m "feat(web): Next.js scaffold with H1 Indigo Emerald theme"
```

---

### Task 11: Anon identity + search page

**Files:**
- Create: `apps/web/src/middleware.ts`, `apps/web/src/lib/clients.ts`, `apps/web/src/components/EventCard.tsx`, `apps/web/src/app/search/page.tsx`

**Interfaces:**
- Consumes: `tmClient`, `dbHttp`, schema from core; theme classes (Task 10).
- Produces: `rhino_anon` cookie (UUID, 1-year, httpOnly=false so localStorage sync possible later); `getClients()` returning `{ db, dbTx, tm, sg }` (dbTx = Pool client, lazy); `<EventCard ev={...} />` used by Tasks 12–13; `/search?q=` page.

- [ ] **Step 1: Middleware mints anon UUID**

`apps/web/src/middleware.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";

export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  if (!req.cookies.get("rhino_anon")) {
    res.cookies.set("rhino_anon", crypto.randomUUID(), {
      maxAge: 60 * 60 * 24 * 365, sameSite: "lax", path: "/",
    });
  }
  return res;
}
```

`apps/web/src/lib/clients.ts`:
```ts
import { dbHttp, dbPool, sgClient, tmClient } from "@ticketrhino/core";
import { env } from "./env";

export function getClients() {
  const e = env();
  return {
    db: dbHttp(e.DATABASE_URL),
    dbTx: () => dbPool(e.DATABASE_URL), // interactive transactions (Track only)
    tm: tmClient(e.TM_API_KEY),
    sg: sgClient(e.SG_CLIENT_ID),
  };
}
```

- [ ] **Step 2: EventCard component**

`apps/web/src/components/EventCard.tsx`:
```tsx
import Link from "next/link";

export type CardData = {
  href: string; name: string; venue: string | null; dateLabel: string;
  artworkUrl: string | null; price: string | null; delta: number | null;
};

export function EventCard({ ev }: { ev: CardData }) {
  const deltaColor = ev.delta == null ? undefined : ev.delta <= 0 ? "var(--emerald)" : "var(--red)";
  return (
    <Link href={ev.href} className="glass-card mb-3 flex items-center gap-3 p-3 transition hover:-translate-y-0.5">
      <div className="h-11 w-11 shrink-0 rounded-lg bg-gradient-to-br from-violet-900 to-violet-600"
        style={ev.artworkUrl ? { backgroundImage: `url(${ev.artworkUrl})`, backgroundSize: "cover" } : undefined} />
      <div className="min-w-0 flex-1">
        <div className="headline-serif truncate text-[15px] font-bold text-white">{ev.name}</div>
        <div className="text-[11px]" style={{ color: "var(--peri)" }}>{ev.venue} · {ev.dateLabel}</div>
      </div>
      <div className="text-right">
        {ev.price && <div className="price-mono text-[15px] font-bold" style={{ color: deltaColor ?? "#e5e7eb" }}>{ev.price}</div>}
        {ev.delta != null && (
          <div className="price-mono text-[10px]" style={{ color: deltaColor }}>
            {ev.delta <= 0 ? "▼" : "▲"} {Math.abs(ev.delta * 100).toFixed(0)}%
          </div>
        )}
      </div>
    </Link>
  );
}
```

- [ ] **Step 3: Search page (TM live + local overlay)**

`apps/web/src/app/search/page.tsx`:
```tsx
import { inArray } from "drizzle-orm";
import { schema } from "@ticketrhino/core";
import { getClients } from "@/lib/clients";
import { CardData, EventCard } from "@/components/EventCard";

export const dynamic = "force-dynamic";

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  if (!q) return <p className="label-caps">SEARCH ARTIST, EVENT, VENUE</p>;
  const { db, tm } = getClients();
  const results = await tm.search(q); // server-side, Next fetch cache handles 5-min TTL via revalidate on fetch
  if (!results.length) return <p className="mt-8 text-center text-gray-400">Nothing found — try artist or venue name</p>;

  // merge rule (spec §8): key by tm_id, overlay local rows only
  const local = await db.select().from(schema.events)
    .where(inArray(schema.events.tmId, results.map((r) => r.tmId)));
  const byTmId = new Map(local.map((e) => [e.tmId, e]));

  const cards: CardData[] = results.map((r) => {
    const l = byTmId.get(r.tmId);
    return {
      href: l ? `/event/${l.id}` : `/event/tm/${r.tmId}`,
      name: r.name, venue: r.venue,
      dateLabel: r.startsAt.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      artworkUrl: r.artworkUrl,
      price: r.priceLow != null ? `$${r.priceLow}` : null, delta: null,
    };
  });
  return <div>{cards.map((c) => <EventCard key={c.href} ev={c} />)}</div>;
}
```
Note: core's `tmClient` uses plain `fetch`, which Next auto-caches per-URL; add `next: { revalidate: 300 }` support by passing a wrapped fetch in `getClients()` if cache verification shows misses: `tmClient(e.TM_API_KEY, (url, init) => fetch(url, { ...init, next: { revalidate: 300 } }))`.

- [ ] **Step 4: Verify**

Run: `pnpm --filter web build`
Expected: build succeeds. Manual: `TM_API_KEY=... DATABASE_URL=... pnpm --filter web dev`, open `/search?q=test` — renders cards or empty state.

- [ ] **Step 5: Commit**

```bash
git add apps/web && git commit -m "feat(web): anon cookie middleware, event card, live TM search with local overlay"
```

---

### Task 12: Event detail + Track action + home + watchlist

**Files:**
- Create: `apps/web/src/app/event/[id]/page.tsx` (DB-backed), `apps/web/src/app/event/tm/[tmId]/page.tsx` (live untracked), `apps/web/src/app/actions.ts`, `apps/web/src/lib/cards.ts`, `apps/web/src/components/PriceRows.tsx`, `apps/web/src/components/HistoryChart.tsx`, `apps/web/src/components/TrackButton.tsx`
- Modify: `apps/web/src/app/page.tsx` (trending), create `apps/web/src/app/watchlist/page.tsx`

**Interfaces:**
- Consumes: core `trackEvent`/`untrackEvent`, `signals`, schema; `getClients()`; `EventCard`.
- Produces: complete 3-page V1 UI.

- [ ] **Step 1: Server actions**

`apps/web/src/app/actions.ts`:
```tsx
"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { trackEvent, untrackEvent } from "@ticketrhino/core";
import { getClients } from "@/lib/clients";

export async function trackAction(tmId: string): Promise<{ ok: boolean; message?: string }> {
  const anonId = (await cookies()).get("rhino_anon")?.value;
  if (!anonId) return { ok: false, message: "No session" };
  const { dbTx, tm, sg } = getClients();
  const ev = await tm.getEvent(tmId);
  if (!ev) return { ok: false, message: "Event unavailable" };
  const res = await trackEvent(dbTx(), anonId, ev, sg);
  if (!res.ok) return { ok: false, message: "Watchlist full — untrack something first" };
  revalidatePath("/watchlist");
  return { ok: true };
}

export async function untrackAction(eventId: number) {
  const anonId = (await cookies()).get("rhino_anon")?.value;
  if (!anonId) return;
  await untrackEvent(getClients().dbTx(), anonId, eventId);
  revalidatePath("/watchlist");
}
```

- [ ] **Step 2: Price rows + chart + track button components**

`apps/web/src/components/PriceRows.tsx`:
```tsx
type Primary = { low: string | null; high: string | null } | null;
type Resale = { low: string | null; avg: string | null; high: string | null; listings: number | null } | null;

// spec §2: two labeled rows, never a combined winner
export function PriceRows({ primary, resale }: { primary: Primary; resale: Resale }) {
  return (
    <div className="space-y-2">
      <div className="glass-card flex items-center justify-between p-3">
        <div>
          <div className="label-caps">PRIMARY · TICKETMASTER</div>
          <div className="text-[10px] text-gray-500">face value range</div>
        </div>
        <div className="price-mono text-[15px] font-bold">
          {primary?.low != null ? `$${primary.low}–$${primary.high}` : "—"}
        </div>
      </div>
      <div className="glass-card flex items-center justify-between p-3"
        style={{ borderColor: "rgba(52,211,153,.35)", background: "rgba(52,211,153,.07)" }}>
        <div>
          <div className="label-caps" style={{ color: "var(--emerald)" }}>RESALE · SEATGEEK</div>
          <div className="text-[10px] text-gray-500">
            {resale ? `${resale.listings ?? "?"} listings` : "no resale data yet"}
          </div>
        </div>
        {resale && (
          <div className="text-right">
            <div className="price-mono text-[15px] font-bold" style={{ color: "var(--emerald)" }}>from ${resale.low}</div>
            <div className="price-mono text-[10px] text-gray-500">avg ${resale.avg} · high ${resale.high}</div>
          </div>
        )}
      </div>
    </div>
  );
}
```

`apps/web/src/components/HistoryChart.tsx`:
```tsx
import type { SnapPoint } from "@ticketrhino/core";

// dimmed bars, emerald recent bars with glow (H1 system). Hidden (<48h) handled by caller.
export function HistoryChart({ points }: { points: SnapPoint[] }) {
  const max = Math.max(...points.map((p) => p.priceLow));
  return (
    <div className="flex h-14 items-end gap-[3px]">
      {points.map((p, i) => {
        const recent = i >= points.length - 2;
        return (
          <div key={p.pollBucket.getTime()}
            className={`flex-1 rounded-[2px] ${recent ? "glow-emerald" : ""}`}
            style={{
              height: `${(p.priceLow / max) * 100}%`,
              background: recent ? "var(--emerald)" : "rgba(255,255,255,.08)",
            }} />
        );
      })}
    </div>
  );
}
```

`apps/web/src/components/TrackButton.tsx`:
```tsx
"use client";
import { useState, useTransition } from "react";
import { trackAction, untrackAction } from "@/app/actions";

export function TrackButton({ tmId, eventId, tracked }: { tmId: string; eventId?: number; tracked: boolean }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [isTracked, setTracked] = useState(tracked);
  return (
    <div>
      <button
        disabled={pending}
        onClick={() => start(async () => {
          if (isTracked && eventId != null) { await untrackAction(eventId); setTracked(false); return; }
          const res = await trackAction(tmId);
          if (res.ok) setTracked(true); else setMsg(res.message ?? "Failed");
        })}
        className="w-full rounded-xl py-3 text-sm font-extrabold"
        style={{ background: "linear-gradient(90deg,#059669,var(--emerald))", color: "#022c22" }}>
        {pending ? "…" : isTracked ? "✓ Tracking — tap to untrack" : "＋ Track this event"}
      </button>
      {msg && <p className="mt-2 text-center text-xs" style={{ color: "var(--red)" }}>{msg}</p>}
    </div>
  );
}
```

- [ ] **Step 3: DB-backed event detail**

`apps/web/src/app/event/[id]/page.tsx`:
```tsx
import { and, asc, eq, gte } from "drizzle-orm";
import { cookies } from "next/headers";
import type { Metadata } from "next";
import { delta24h, isLowest30d, schema, SnapPoint, weekDelta } from "@ticketrhino/core";
import { getClients } from "@/lib/clients";
import { HistoryChart } from "@/components/HistoryChart";
import { PriceRows } from "@/components/PriceRows";
import { TrackButton } from "@/components/TrackButton";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false } }; // spec §7: noindex /event/*

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const { db } = getClients();
  const [ev] = await db.select().from(schema.events).where(eq(schema.events.id, id));
  if (!ev) return <p className="mt-8 text-center text-gray-400">Event not found</p>;

  const since = new Date(Date.now() - 30 * 86_400_000);
  const snaps = await db.select().from(schema.priceSnapshots)
    .where(and(eq(schema.priceSnapshots.eventId, id), gte(schema.priceSnapshots.pollBucket, since)))
    .orderBy(asc(schema.priceSnapshots.pollBucket));

  const resaleSnaps = snaps.filter((s) => s.source === "seatgeek" && s.priceLow != null);
  const points: SnapPoint[] = resaleSnaps.map((s) => ({ pollBucket: s.pollBucket, priceLow: Number(s.priceLow) }));
  const latestResale = resaleSnaps.at(-1) ?? null;
  const latestPrimary = snaps.filter((s) => s.source === "tm").at(-1) ?? null;
  const latest = [latestResale, latestPrimary].filter(Boolean)
    .sort((a, b) => b!.fetchedAt.getTime() - a!.fetchedAt.getTime())[0] ?? null;

  const now = new Date();
  const week = weekDelta(points, now);
  const lowest = isLowest30d(points, now);
  const day = delta24h(points, now);
  const spanMs = points.length >= 2 ? points.at(-1)!.pollBucket.getTime() - points[0].pollBucket.getTime() : 0;
  const staleMin = latest ? Math.round((now.getTime() - latest.fetchedAt.getTime()) / 60_000) : null;

  const anonId = (await cookies()).get("rhino_anon")?.value;
  const tracked = anonId ? (await db.select().from(schema.watchlistEvents)
    .where(and(eq(schema.watchlistEvents.anonId, anonId), eq(schema.watchlistEvents.eventId, id)))).length > 0 : false;

  return (
    <div className="space-y-4">
      <div className="glass-card relative h-32 overflow-hidden bg-gradient-to-br from-violet-900 via-violet-600 to-teal-400"
        style={ev.artworkUrl ? { backgroundImage: `url(${ev.artworkUrl})`, backgroundSize: "cover" } : undefined}>
        <div className="absolute bottom-2 left-3">
          <h1 className="headline-serif text-xl font-bold text-white drop-shadow">{ev.name}</h1>
          <p className="text-[11px] text-indigo-100">
            {ev.venue} · {ev.startsAt.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: ev.eventTz ?? "UTC" })}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          {lowest === true && <span className="rounded-full border px-3 py-1 text-[10px] font-bold"
            style={{ color: "var(--emerald)", borderColor: "rgba(52,211,153,.4)", background: "rgba(52,211,153,.12)" }}>↓ Lowest in 30 days</span>}
          {week != null && <span className="price-mono text-[11px] font-bold"
            style={{ color: week <= 0 ? "var(--emerald)" : "var(--red)" }}>
            {week <= 0 ? "▼" : "▲"} {Math.abs(week * 100).toFixed(1)}% this week</span>}
          {day != null && week == null && <span className="price-mono text-[11px] font-bold"
            style={{ color: day <= 0 ? "var(--emerald)" : "var(--red)" }}>
            {day <= 0 ? "▼" : "▲"} {Math.abs(day * 100).toFixed(1)}% today</span>}
        </div>
        {staleMin != null && (
          <span className="text-[10px]" style={{ color: staleMin > 360 ? "#fbbf24" : "#6b7280" }}>
            updated {staleMin < 60 ? `${staleMin} min` : `${Math.round(staleMin / 60)}h`} ago
          </span>
        )}
      </div>

      <PriceRows
        primary={latestPrimary ? { low: latestPrimary.priceLow, high: latestPrimary.priceHigh } : null}
        resale={latestResale ? { low: latestResale.priceLow, avg: latestResale.priceAvg, high: latestResale.priceHigh, listings: latestResale.listingCount } : null} />

      <div>
        <div className="label-caps mb-2">RESALE LOW — 30 DAYS</div>
        {spanMs >= 48 * 3_600_000
          ? <HistoryChart points={points} />
          : null}
        <p className="mt-1 text-[10px] text-gray-500">
          history building since {(points[0]?.pollBucket ?? ev.trackedAt ?? new Date()).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
        </p>
      </div>

      {ev.tmId && <TrackButton tmId={ev.tmId} eventId={ev.id} tracked={tracked} />}
    </div>
  );
}
```

- [ ] **Step 4: Live (untracked) event detail**

`apps/web/src/app/event/tm/[tmId]/page.tsx`:
```tsx
import type { Metadata } from "next";
import { getClients } from "@/lib/clients";
import { PriceRows } from "@/components/PriceRows";
import { TrackButton } from "@/components/TrackButton";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false } };

// spec §8: untracked search result — live TM render, NO DB row until Track
export default async function LiveEventPage({ params }: { params: Promise<{ tmId: string }> }) {
  const { tmId } = await params;
  const ev = await getClients().tm.getEvent(tmId);
  if (!ev) return <p className="mt-8 text-center text-gray-400">Event not found</p>;
  return (
    <div className="space-y-4">
      <div className="glass-card relative h-32 overflow-hidden bg-gradient-to-br from-violet-900 via-violet-600 to-teal-400"
        style={ev.artworkUrl ? { backgroundImage: `url(${ev.artworkUrl})`, backgroundSize: "cover" } : undefined}>
        <div className="absolute bottom-2 left-3">
          <h1 className="headline-serif text-xl font-bold text-white drop-shadow">{ev.name}</h1>
          <p className="text-[11px] text-indigo-100">{ev.venue} · {ev.startsAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</p>
        </div>
      </div>
      <PriceRows primary={ev.priceLow != null ? { low: String(ev.priceLow), high: String(ev.priceHigh) } : null} resale={null} />
      <p className="text-center text-xs text-gray-400">Track to start collecting price history</p>
      <TrackButton tmId={tmId} tracked={false} />
    </div>
  );
}
```

- [ ] **Step 5: Home (trending) + watchlist**

`apps/web/src/lib/cards.ts` (NOT in page.tsx — Next.js pages only allow component/metadata exports):
```ts
import { asc, eq, gte, and } from "drizzle-orm";
import { delta24h, schema } from "@ticketrhino/core";
import { getClients } from "@/lib/clients";
import type { CardData } from "@/components/EventCard";

export async function eventCards(eventRows: (typeof schema.events.$inferSelect)[]): Promise<CardData[]> {
  const { db } = getClients();
  const now = new Date();
  return Promise.all(eventRows.map(async (ev) => {
    const snaps = await db.select().from(schema.priceSnapshots)
      .where(and(eq(schema.priceSnapshots.eventId, ev.id), eq(schema.priceSnapshots.source, "seatgeek"),
        gte(schema.priceSnapshots.pollBucket, new Date(now.getTime() - 2 * 86_400_000))))
      .orderBy(asc(schema.priceSnapshots.pollBucket));
    const points = snaps.filter((s) => s.priceLow != null)
      .map((s) => ({ pollBucket: s.pollBucket, priceLow: Number(s.priceLow) }));
    const latest = points.at(-1);
    return {
      href: `/event/${ev.id}`, name: ev.name, venue: ev.venue,
      dateLabel: ev.startsAt.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      artworkUrl: ev.artworkUrl,
      price: latest ? `$${latest.priceLow}` : null,
      delta: delta24h(points, now),
    };
  }));
}
```

`apps/web/src/app/page.tsx`:
```tsx
import { asc, eq, and } from "drizzle-orm";
import Link from "next/link";
import { schema } from "@ticketrhino/core";
import { getClients } from "@/lib/clients";
import { EventCard } from "@/components/EventCard";
import { eventCards } from "@/lib/cards";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { db } = getClients();
  const trending = await db.select().from(schema.events)
    .where(and(eq(schema.events.isSeed, true), eq(schema.events.pollingEnabled, true)))
    .orderBy(asc(schema.events.startsAt)).limit(20);
  const cards = await eventCards(trending);
  return (
    <div>
      <form action="/search" className="mb-4">
        <input name="q" placeholder="🔍 Search artist, event, venue…"
          className="glass-card w-full p-3 text-sm text-white placeholder-gray-500 outline-none" />
      </form>
      <div className="label-caps mb-2">TRENDING</div>
      {cards.length
        ? cards.map((c) => <EventCard key={c.href} ev={c} />)
        : <p className="text-sm text-gray-400">Seeding events — check back after the next nightly run, or <Link href="/search?q=" className="underline">search</Link>.</p>}
    </div>
  );
}
```

`apps/web/src/app/watchlist/page.tsx`:
```tsx
import { eq, inArray } from "drizzle-orm";
import { cookies } from "next/headers";
import Link from "next/link";
import { schema } from "@ticketrhino/core";
import { getClients } from "@/lib/clients";
import { EventCard } from "@/components/EventCard";
import { eventCards } from "@/lib/cards";

export const dynamic = "force-dynamic";

export default async function WatchlistPage() {
  const anonId = (await cookies()).get("rhino_anon")?.value;
  const { db } = getClients();
  const rows = anonId ? await db.select().from(schema.watchlistEvents)
    .where(eq(schema.watchlistEvents.anonId, anonId)) : [];
  if (!rows.length) {
    return <p className="mt-8 text-center text-sm text-gray-400">
      Nothing tracked yet — <Link href="/" className="underline">browse trending</Link></p>;
  }
  const evs = await db.select().from(schema.events)
    .where(inArray(schema.events.id, rows.map((r) => r.eventId)));
  const cards = (await eventCards(evs))
    .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0)); // biggest movers first
  return (
    <div>
      <div className="label-caps mb-2">WATCHLIST — BIGGEST MOVERS</div>
      {cards.map((c) => <EventCard key={c.href} ev={c} />)}
    </div>
  );
}
```

- [ ] **Step 6: Verify build + typecheck**

Run: `pnpm --filter web build && pnpm --filter web typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/web && git commit -m "feat(web): event detail, track flow, trending home, watchlist"
```

---

### Task 13: Playwright smoke tests + CI wiring

**Files:**
- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/smoke.spec.ts`
- Modify: `apps/web/package.json` (add `"test:e2e": "playwright test"`), `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: running web app + local docker Postgres (Task 2 container) with migrations applied; `TM_API_KEY` optional — tests that need TM are skipped when absent.

- [ ] **Step 1: Config**

```bash
pnpm --filter web add -D @playwright/test && pnpm --filter web exec playwright install chromium
```

`apps/web/playwright.config.ts`:
```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://localhost:3100" },
  webServer: {
    command: "pnpm dev --port 3100",
    port: 3100,
    reuseExistingServer: true,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://postgres:test@localhost:5433/postgres",
      TM_API_KEY: process.env.TM_API_KEY ?? "unset",
      SG_CLIENT_ID: process.env.SG_CLIENT_ID ?? "unset",
    },
  },
});
```

- [ ] **Step 2: Write smoke tests**

`apps/web/e2e/smoke.spec.ts`:
```ts
import { expect, test } from "@playwright/test";

test("home renders header, search box, and TM attribution", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: /TicketRhino/ })).toBeVisible();
  await expect(page.getByPlaceholder(/Search artist/)).toBeVisible();
  await expect(page.getByText(/Event data by/)).toBeVisible();
});

test("empty watchlist shows CTA to trending", async ({ page }) => {
  await page.goto("/watchlist");
  await expect(page.getByText(/Nothing tracked yet/)).toBeVisible();
});

test("event page for unknown id shows not-found state, never hard-fails", async ({ page }) => {
  await page.goto("/event/999999");
  await expect(page.getByText(/Event not found/)).toBeVisible();
});

test("anon cookie minted on first visit", async ({ page, context }) => {
  await page.goto("/");
  const cookie = (await context.cookies()).find((c) => c.name === "rhino_anon");
  expect(cookie?.value).toMatch(/^[0-9a-f-]{36}$/);
});

test.describe("live TM path", () => {
  test.skip(!process.env.TM_API_KEY, "needs TM_API_KEY");
  test("search renders results and event page shows PRIMARY row", async ({ page }) => {
    await page.goto("/search?q=concert");
    const first = page.locator("a[href^='/event/']").first();
    await expect(first).toBeVisible();
    await first.click();
    await expect(page.getByText("PRIMARY · TICKETMASTER")).toBeVisible();
    await expect(page.getByText("RESALE · SEATGEEK")).toBeVisible();
  });
});
```

- [ ] **Step 3: Run locally**

```bash
docker start trhino-pg
pnpm --filter web test:e2e
```
Expected: 4 passed, 1 skipped (no TM key) — or 5 passed with key.

- [ ] **Step 4: CI job**

Append job to `.github/workflows/ci.yml`:
```yaml
  e2e:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_PASSWORD: test }
        ports: ["5433:5432"]
        options: >-
          --health-cmd pg_isready --health-interval 5s --health-timeout 5s --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @ticketrhino/core exec drizzle-kit migrate
        env: { DATABASE_URL: "postgresql://postgres:test@localhost:5433/postgres" }
      - run: pnpm --filter web exec playwright install chromium --with-deps
      - run: pnpm --filter web test:e2e
```

- [ ] **Step 5: Commit + verify CI**

```bash
git add apps/web .github && git commit -m "test(web): playwright smoke suite + CI e2e job" && git push
gh run watch
```
Expected: CI green.

---

### Task 14: Deploy runbook

**Files:**
- Create: `docs/DEPLOY.md` (the commands below, for repeatability)

**Interfaces:**
- Consumes: everything. Produces: live URL + collecting poller.

- [ ] **Step 1: Matt's manual prerequisites** (blocking, human-only)
  - TM key: developer.ticketmaster.com → app → Consumer Key.
  - SG credentials: seatgeek.com/account/develop → client_id. Verify with:
    `curl "https://api.seatgeek.com/2/events?client_id=<ID>&per_page=1" | jq '.events[0].stats'` — must contain `lowest_price`, `average_price`, `highest_price`, `listing_count`. If any missing, adjust `PriceRows` resale line before launch.

- [ ] **Step 2: Neon**

```bash
# create project in Neon console (free tier), copy pooled connection string
cd packages/core && DATABASE_URL="<neon-url>" pnpm drizzle-kit migrate
```

- [ ] **Step 3: Cloudflare Worker**

```bash
cd apps/worker
pnpm wrangler secret put DATABASE_URL
pnpm wrangler secret put TM_API_KEY
pnpm wrangler secret put SG_CLIENT_ID
pnpm wrangler deploy
# force a first scheduled run to smoke-test:
pnpm wrangler dev --test-scheduled   # then: curl "http://localhost:8787/__scheduled?cron=0+5+*+*+*"
```
The nightly trigger seeds trending events. Verify: `select count(*) from events where is_seed;` → up to 50.

- [ ] **Step 4: Vercel**

```bash
cd apps/web && vercel link
vercel env add DATABASE_URL production
vercel env add TM_API_KEY production
vercel env add SG_CLIENT_ID production
vercel --prod
```
Vercel monorepo settings: root directory `apps/web`.

- [ ] **Step 5: End-to-end verification**
  - Open prod URL on phone: trending grid renders seeded events.
  - Track one event; confirm row in `watchlist_events` and `event_source_state` has both sources (if SG matched).
  - Wait ≥20 min; `select count(*) from price_snapshots;` growing. Poll cadence: TM rows ~2h apart, SG ~1h.
  - `robots.txt` served; event page has `noindex` meta.

- [ ] **Step 6: Commit runbook + share**

```bash
git add docs/DEPLOY.md && git commit -m "docs: deploy runbook" && git push
```
Send friend the URL. 🦏

---

## Self-Review Notes

- Spec coverage: §2 labels (Task 12 PriceRows), §3 budget (Task 6 constants + test), §4 schema (Task 2), §5 poller+nightly+matching (Tasks 6, 7, 5), §6 track/caps (Task 8), §7 pages/signals/empty states (Tasks 3, 10–12), §8 read path (Tasks 11, 12), §9 error behaviors (backoff Task 4, lease Task 6, never-hard-fail Task 13 test), §10 testing (Tasks 2–9 unit, 13 e2e + CI), §11 deploy (Task 14). No uncovered requirement found.
- Type consistency: `SnapPoint`, `TmEvent`, `SgStats`, `ClaimedRow`, `TrackResult` defined once in core and consumed by name in Tasks 11–12.
- Known deliberate cut: no "prices paused" error boundary page (spec §9 row 4) — Next.js default error boundary suffices for V1; revisit if Neon flaps.
