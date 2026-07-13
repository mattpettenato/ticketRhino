# TicketRhino V1 — Design Spec

**Date:** 2026-07-13
**Status:** Approved pending final review
**Reviews:** 2× multi-model senate reviews (architecture; design + data model), amendments incorporated.

## 1. Product

Ticket-price aggregator. Searches live events, compares prices across marketplaces (primary vs resale), and self-collects hourly price snapshots to power "best time to buy" trend charts and signals. Shared with friends via public URL. Mobile-first, dark, Instagram-worthy UI.

**Core insight/constraint:** no public API provides ticket price *history*. The snapshot dataset accrues forward-only from deploy day and is irreplaceable — protecting its integrity drives most design decisions below.

### Goals (V1)
- Search artist/event/venue → event page with live price comparison (Ticketmaster face value vs SeatGeek resale stats)
- Price-history chart + honest computed signals ("↓12% this week", "lowest in 30 days") that unlock as data accrues
- Track events (no auth) and see biggest movers
- $0/month infrastructure; deployed and usable on a phone

### Non-goals (V1)
Accounts/auth · price alerts/notifications · sell-side analytics · StubHub/VividSeats sources · native app · ML price prediction (V2) · monetization of any kind (ToS requirement, not just scope cut).

## 2. Data sources

| Source | API | Gives | Label in UI |
|---|---|---|---|
| Ticketmaster | Discovery API (free key) | events, venues, artwork, genres, face-value price ranges | **Primary · Ticketmaster** |
| SeatGeek | Platform API (client_id) | resale listing stats: lowest/average/highest price, listing count | **Resale · SeatGeek** |

- **Never** combine the two into a single "best price winner" — face value and resale are different markets. Always two labeled rows.
- SeatGeek API verified alive (rejects invalid credentials with structured error). **Action item: register at seatgeek.com/account/develop for credentials.** Fallback if denied: ship TM-only, add resale source later.
- ToS: TM attribution + logo mandatory; non-commercial use only (also Vercel Hobby requirement). No ads, no payments.
- StubHub excluded: partner-only API; scraping violates ToS.

## 3. Architecture

```
┌────────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│ Next.js (Vercel)    │────▶│ Neon Postgres     │◀────│ Cloudflare Worker    │
│ App Router+Tailwind │read │ events, snapshots │write│ cron */10min poller  │
│ UI + read APIs      │     │ (free tier 0.5GB) │     │ + nightly cleanup    │
└────────────────────┘     └──────────────────┘     └───────┬─────────────┘
                                                    ┌────────┴─────────┐
                                                    │ TM Discovery API  │
                                                    │ SeatGeek API      │
                                                    └──────────────────┘
```

- One public GitHub repo, two deploy targets: Vercel (web) + Wrangler (worker).
- Monorepo layout: `apps/web` (Next.js), `apps/worker` (poller), `packages/db` (Drizzle schema + client, shared).
- Secrets: TM/SeatGeek keys + `DATABASE_URL` in Cloudflare Worker secrets; Vercel gets `DATABASE_URL` + TM key (live search is server-side in Next.js). Nothing in the repo.
- Cost: $0/month (Vercel Hobby, Neon free, Cloudflare Workers free).

### Why cron every 10 minutes, not hourly batch
Cloudflare Workers free plan: **50 subrequests per invocation**. 150 events × 2 APIs = 300 fetches — impossible in one run. Each run claims **≤45 due source-rows** (45 API calls + a handful of batched DB writes ≤ 50 subrequests; backoff retries count against the same per-run budget — unfinished rows simply stay due for the next run). Scheduling via `next_poll_at` gives each event TM every 2h / SeatGeek every 1h. 10ms CPU limit is fine — polling is I/O-bound.

### Quota + throughput budget (documented in code, enforced by `next_poll_at`)
All caps are stated in **source-rows** (one row = one event × one source = one API call).
- Demand: TM 150 × 12/day = 1,800 + seed refresh ~50 ≈ 1,850 of 5,000/day ✓ · SeatGeek 150 × 24 = 3,600/day ✓ · total 5,450 source-polls/day
- Capacity: 144 runs/day × 45 rows = 6,480/day → ~19% headroom for retries/backoff ✓

## 4. Data model (Neon Postgres, Drizzle ORM)

```
events
  id                serial PK
  tm_id             text NULL, UNIQUE WHERE NOT NULL
  sg_id             text NULL, UNIQUE WHERE NOT NULL
  name, artist      text
  venue, city       text
  event_tz          text                -- IANA tz for "today" price-move calcs
  starts_at         timestamptz
  event_status      text                -- upcoming | rescheduled | canceled | past
  artwork_url       text
  genre             text
  match_confidence  real                -- cross-source match quality 0..1
  match_method      text                -- exact_id | fuzzy | manual
  matched_at        timestamptz
  is_seed           boolean             -- in curated trending seed
  polling_enabled   boolean             -- maintained invariant: is_seed OR watchers > 0
  tracked_at        timestamptz
  idx: (polling_enabled, starts_at)

event_source_state                       -- per-source health/cadence, independent
  PK (event_id, source)                  -- source: tm | seatgeek
  last_polled_at, next_poll_at timestamptz
  error_count       int
  last_error_at     timestamptz
  idx: (next_poll_at)
  -- lifecycle: row created only when that source's ID is known — ('tm') when
  -- tm_id set, ('seatgeek') when sg_id set via cross-match. Initial
  -- next_poll_at = now(). No phantom rows for unmatched sources.

watchlist_events                         -- user watchlist ≠ polling set
  PK (anon_id, event_id)                 -- anon_id: UUID (cookie + localStorage)
  created_at        timestamptz
  -- per-UUID cap: 20

price_snapshots
  id                bigserial PK
  event_id          int FK
  source            text                -- tm | seatgeek
  price_low, price_avg, price_high  numeric(10,2)
  listing_count     int NULL            -- resale only
  currency          char(3) DEFAULT 'USD'
  poll_bucket       timestamptz         -- date_trunc('hour', now())
  fetched_at        timestamptz DEFAULT now()   -- DB clock, informational
  UNIQUE (event_id, source, poll_bucket)        -- true idempotency key
  idx: (poll_bucket), (event_id, poll_bucket DESC)
```

**Why `poll_bucket` in the unique key:** per-attempt `fetched_at` timestamps never collide, so retries and overlapping runs would insert silent duplicate rows and corrupt every trend calculation. Hour-truncated bucket + `ON CONFLICT DO NOTHING` makes re-runs genuinely idempotent.

## 5. Poller (Cloudflare Worker)

**Cron `*/10 * * * *` — lease-claim pattern (no global lock):**
1. **Claim** ≤45 due source-rows atomically in one statement:
   ```sql
   UPDATE event_source_state SET next_poll_at = now() + interval '9 minutes'
   WHERE (event_id, source) IN (
     SELECT event_id, source FROM event_source_state ess JOIN events e USING (event_id)
     WHERE ess.next_poll_at <= now() AND e.polling_enabled
       AND e.event_status NOT IN ('canceled','past')
       AND e.starts_at > now() - interval '24 hours'
       AND (ess.error_count < 3 OR ess.last_error_at < now() - interval '6 hours')
     ORDER BY ess.next_poll_at LIMIT 45 FOR UPDATE SKIP LOCKED)
   RETURNING event_id, source, ...
   ```
   The 9-minute lease doubles as the overlap guard: concurrent/overlapping runs claim disjoint rows (`SKIP LOCKED`), and a crashed run's rows simply come due again next cycle. Works over `@neondatabase/serverless` HTTP driver — no session-scoped advisory lock needed (that driver is connection-per-query, so advisory locks would silently no-op).
2. Per claimed row: fetch API (exponential backoff on 429/5xx within the run's subrequest budget; give up → row stays leased 9 min, retried next run) → upsert snapshot (`ON CONFLICT (event_id, source, poll_bucket) DO NOTHING` — conflict still counts as success; cadence governs frequency, the bucket only dedupes overlap) → update `last_polled_at`, set `next_poll_at` = now() + 2h (TM) / + 1h (SG), **error_count = 0 on success** / +1 on failure — commit per row as you go.

**Cron `0 5 * * *` (nightly):**
- `event_status = 'past'`, `polling_enabled = false` where `starts_at < now() - interval '24 hours'`; delete their `watchlist_events` rows (frees cap slots; orphaned anon UUIDs clean themselves up this way as their events pass)
- Delete `price_snapshots` older than 90 days
- Refresh trending seed: TM popular query, fuzzy-match against existing, insert new with `is_seed = true` **only up to the 50-slot seed budget** (seed slots are reserved out of the 150 global cap: 50 seed + 100 user-tracked; calls counted in TM budget)

**Error recovery:** 3 consecutive failures → 6h cooldown → retry; `error_count` resets to 0 on any successful poll. Nothing is ever permanently dead.

**Cross-source matching:** new event from one source fuzzy-matches candidates from the other on artist + venue + date (±1 day). Auto-link at `match_confidence >= 0.8`; below that, leave unlinked (single-source display). `manual`/`exact_id` matches are never overwritten by `fuzzy`. V1 discovers events via TM only — SeatGeek-only events are intentionally out of scope (SG is matched *to* TM events, not discovered independently). Artwork/genre: TM values win; SG fills nulls only.

## 6. Tracking flow

- **Polling set** = curated trending seed (reserved 50 slots) + user-tracked events (100 slots). Global cap 150; per anon UUID cap 20. `polling_enabled` is a maintained invariant: `is_seed OR EXISTS(watchlist_events)` — untracking only disables polling when the last watcher leaves AND the event isn't seed.
- **Page views NEVER mutate the polling set** (quota-bomb guard — top finding of both reviews).
- Track button, cap-full behavior (user pool of 100 full): first evict tracked events whose `starts_at < now()` (started/past events are evictable even inside the poller's 24h grace window — the grace only keeps *polling* alive, not the slot claim); if still full, reject with "Watchlist full" message. Tracking an already-polled event (seed or another user's) always succeeds — it just adds a watchlist row, no new slot. No silent eviction of other users' picks.
- Anonymous identity: UUID minted on first visit, stored cookie + localStorage, watchlist persisted server-side keyed by UUID. Clearing both forks identity — accepted for V1; orphaned watchlist rows are purged when their events pass (nightly job), so squatted slots self-free.

## 7. Pages & UI

**Visual system — "H1 Indigo Emerald"** (mockups: `.superpowers/brainstorm/`):
- Background: radial indigo night `radial-gradient(at 20% 0%, #1e1b4b → #0c0a1d)`
- Cards: glassmorphism — `rgba(255,255,255,.04)`, 1px `rgba(255,255,255,.12)` border, 16–20px radius, backdrop blur
- Headlines: serif italic (Georgia/Fraunces) · body: system sans · prices/deltas: monospace
- Accents: emerald `#34d399` (down/good), red `#f87171` (up), periwinkle `#818cf8`/`#c7d2fe` labels
- Sparklines: dimmed bars, emerald recent bars with soft glow
- Motion: subtle; number tick animations, card hover lift. No confetti.

**Pages (3):**
1. **Home/Explore** — logo + watchlist link; search bar; genre chips; TRENDING grid of event cards (artwork thumb, serif title, venue/date, mono best-resale price + 24h % delta)
2. **Event detail** — hero artwork w/ title overlay; signal chip row ("↓ Lowest in 30 days") + staleness badge ("updated 42 min ago"); PRIMARY row (TM face range) + RESALE row (SG from/avg/high + listing count) as separate labeled cards; 30-day resale-low chart; "history building since <date>" caption; Track button
3. **Watchlist** — tracked events list, sorted by biggest 24h movers; empty state → CTA to trending

**Signals (data-gated — never shown without enough history; all windows are rolling UTC intervals from `now()`, not calendar days — `event_tz` is display-only):**
- "↓/↑ N% this week" — requires ≥7 days of snapshots
- "Lowest price in 30 days" — requires ≥14 days
- 24h delta on cards — requires ≥2 buckets ≥20h apart within the rolling 24h window

**Error/empty states:**
- Search no results → "Nothing found — try artist or venue name"
- No SeatGeek match → primary row only + "no resale data yet"
- History <48h → chart hidden, caption only
- Data stale >6h → amber staleness badge
- Track cap → "Watchlist full — untrack something first"
- Upstream API down → cached/last-known prices + staleness badge (page never hard-fails)

**SEO/crawlers:** `robots.txt` disallow + `noindex` on `/event/*` (crawler-driven load guard).

## 8. Read path (Next.js)

- Server components query Neon directly via Drizzle (`@neondatabase/serverless` HTTP driver)
- Search: TM Discovery live search (server-side, cached 5 min via Next fetch cache). Merge rule: results keyed by `tm_id` — if a local `events` row with that `tm_id` exists, overlay its data (tracked state, snapshot prices, sg link); otherwise show the raw TM result. No fuzzy matching at search time; an event enters the DB only when tracked or seeded.
- Event detail: latest snapshot per source + windowed history aggregates
- No client-side API keys ever; all upstream calls server-side

## 9. Error handling summary

| Failure | Behavior |
|---|---|
| Upstream 429/5xx in poller | backoff, per-source error count, 6h cooldown, auto-recover |
| Worker dies mid-batch | per-event commits + idempotent bucket key → safe re-run |
| Cron overlap | lease-claim (`SKIP LOCKED` + 9-min lease), runs claim disjoint rows |
| Neon unreachable from web | error boundary page, "prices paused" message |
| Bad/missing API data | skip snapshot, log, never write partial garbage |

## 10. Testing

- `packages/db`: schema + query unit tests against local Postgres (docker) — snapshot idempotency (same bucket twice → one row), cap eviction logic, signal gating math
- `apps/worker`: poller unit tests w/ mocked fetch — backoff, error-count transitions, cooldown recovery, quota budget per run ≤ subrequest limit
- `apps/web`: Playwright smoke — search → event page renders both price rows labeled, track/untrack, watchlist, empty states
- CI: GitHub Actions on PR (lint, typecheck, tests)

## 11. Deployment & day-one actions

1. Create public GitHub repo `ticketRhino`
2. **Matt (manual):** TM Discovery key (developer.ticketmaster.com) + SeatGeek credentials (seatgeek.com/account/develop). On receipt, verify SG events endpoint actually returns `stats.lowest_price/average_price/highest_price` AND `stats.listing_count` — the UI depends on all four; adjust the resale row if any are missing.
3. Neon project + Drizzle migrations
4. Vercel project (apps/web) + Cloudflare Worker (wrangler) with secrets
5. Seed trending events; verify first snapshots land; share URL

## 12. V2 ideas (parked)

Price alerts (needs auth/push) · buy/sell recommendation model on accrued data · more sources · per-section price tracking · social share cards of price charts (TikTok/IG export).
