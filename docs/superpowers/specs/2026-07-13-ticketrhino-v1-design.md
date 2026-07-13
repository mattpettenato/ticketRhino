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
- Secrets: TM/SeatGeek keys + `DATABASE_URL` in Cloudflare Worker secrets; Vercel gets `DATABASE_URL` only. Nothing in the repo.
- Cost: $0/month (Vercel Hobby, Neon free, Cloudflare Workers free).

### Why cron every 10 minutes, not hourly batch
Cloudflare Workers free plan: **50 subrequests per invocation**. 150 events × 2 APIs = 300 fetches — impossible in one run. Each run polls ≤20 due events (~40 API calls + batched DB writes < 50). Scheduling via `next_poll_at` gives each event TM every 2h / SeatGeek every 1h. 10ms CPU limit is fine — polling is I/O-bound.

### Quota budget (documented in code, enforced by `next_poll_at`)
- TM: 150 events × 12 polls/day = 1,800 + seed refresh (~50 calls/day) ≈ 1,850 of 5,000/day ✓
- SeatGeek: 150 × 24 = 3,600/day (documented limits generous; monitor) ✓

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
  polling_enabled   boolean             -- poller eligibility (seed or watchlisted)
  tracked_at        timestamptz
  idx: (polling_enabled, starts_at)

event_source_state                       -- per-source health/cadence, independent
  PK (event_id, source)                  -- source: tm | seatgeek
  last_polled_at, next_poll_at timestamptz
  error_count       int
  last_error_at     timestamptz
  idx: (next_poll_at)

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

**Cron `*/10 * * * *`:**
1. Acquire overlap lock (Postgres advisory lock; skip run if held)
2. Select ≤20 due rows from `event_source_state` joined to `events`:
   `next_poll_at <= now()` AND `polling_enabled` AND `event_status NOT IN ('canceled','past')` AND `starts_at > now() - interval '24 hours'` AND (`error_count < 3` OR `last_error_at < now() - interval '6 hours'`)
3. Per event-source: fetch API (exponential backoff on 429/5xx, bounded to stay under subrequest budget) → upsert snapshot → update `last_polled_at`, set `next_poll_at` (+2h TM / +1h SG), reset or increment `error_count` — **commit per event as you go** (worker death mid-batch loses nothing)
4. Release lock

**Cron `0 5 * * *` (nightly):**
- `event_status = 'past'`, `polling_enabled = false` where `starts_at < now() - interval '24 hours'` (frees cap slots)
- Delete `price_snapshots` older than 90 days
- Refresh trending seed: TM popular query (~50 events), fuzzy-match against existing, insert new (calls counted in TM budget)

**Error recovery:** 3 consecutive failures → 6h cooldown → retry; count decays on success. Nothing is ever permanently dead.

**Cross-source matching:** new event from one source fuzzy-matches candidates from the other on artist + venue + date (±1 day). Store `match_confidence`/`match_method`. Confident manual/exact matches never overwritten by weaker fuzzy matches. Unmatched events show single-source data.

## 6. Tracking flow

- **Polling set** = curated trending seed (~50) + explicitly tracked events. Hard caps: 150 global, 20 per anon UUID.
- **Page views NEVER mutate the polling set** (quota-bomb guard — top finding of both reviews).
- Track button, cap-full behavior: evict past-date tracked events first; if still full, reject with "Watchlist full" message. No silent eviction of other users' picks.
- Anonymous identity: UUID minted on first visit, stored cookie + localStorage, watchlist persisted server-side keyed by UUID. Clearing both forks identity — accepted for V1.

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

**Signals (data-gated — never shown without enough history):**
- "↓/↑ N% this week" — requires ≥7 days of snapshots
- "Lowest price in 30 days" — requires ≥14 days
- 24h delta on cards — requires ≥2 buckets ≥20h apart

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
- Search: TM Discovery live search (server-side, cached 5 min via Next fetch cache) merged with local `events` rows
- Event detail: latest snapshot per source + windowed history aggregates
- No client-side API keys ever; all upstream calls server-side

## 9. Error handling summary

| Failure | Behavior |
|---|---|
| Upstream 429/5xx in poller | backoff, per-source error count, 6h cooldown, auto-recover |
| Worker dies mid-batch | per-event commits + idempotent bucket key → safe re-run |
| Cron overlap | advisory lock, second run no-ops |
| Neon unreachable from web | error boundary page, "prices paused" message |
| Bad/missing API data | skip snapshot, log, never write partial garbage |

## 10. Testing

- `packages/db`: schema + query unit tests against local Postgres (docker) — snapshot idempotency (same bucket twice → one row), cap eviction logic, signal gating math
- `apps/worker`: poller unit tests w/ mocked fetch — backoff, error-count transitions, cooldown recovery, quota budget per run ≤ subrequest limit
- `apps/web`: Playwright smoke — search → event page renders both price rows labeled, track/untrack, watchlist, empty states
- CI: GitHub Actions on PR (lint, typecheck, tests)

## 11. Deployment & day-one actions

1. Create public GitHub repo `ticketRhino`
2. **Matt (manual):** TM Discovery key (developer.ticketmaster.com) + SeatGeek credentials (seatgeek.com/account/develop)
3. Neon project + Drizzle migrations
4. Vercel project (apps/web) + Cloudflare Worker (wrangler) with secrets
5. Seed trending events; verify first snapshots land; share URL

## 12. V2 ideas (parked)

Price alerts (needs auth/push) · buy/sell recommendation model on accrued data · more sources · per-section price tracking · social share cards of price charts (TikTok/IG export).
