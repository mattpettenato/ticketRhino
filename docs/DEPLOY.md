# Deploy Runbook

## Step 1: Matt's manual prerequisites (blocking, human-only)

- Obtain TM API key from developer.ticketmaster.com → app → Consumer Key.
- Obtain SG credentials from seatgeek.com/account/develop → client_id.
- Verify SG credentials with:
  ```bash
  curl "https://api.seatgeek.com/2/events?client_id=<ID>&per_page=1" | jq '.events[0].stats'
  ```
  Must contain `lowest_price`, `average_price`, `highest_price`, `listing_count`. If any missing, adjust `PriceRows` resale line before launch.

## Step 2: Neon

Create project in Neon console (free tier), copy pooled connection string:

```bash
cd packages/core && DATABASE_URL="<neon-url>" pnpm drizzle-kit migrate
```

## Step 3: Cloudflare Worker

```bash
cd apps/worker
pnpm wrangler secret put DATABASE_URL
pnpm wrangler secret put TM_API_KEY
pnpm wrangler secret put SG_CLIENT_ID
pnpm wrangler deploy
```

Force a first scheduled run to smoke-test:

```bash
pnpm wrangler dev --test-scheduled
# then: curl "http://localhost:8787/__scheduled?cron=0+5+*+*+*"
```

Verify nightly trigger seeds trending events:

```sql
select count(*) from events where is_seed;
-- Expected: up to 50
```

## Step 4: Vercel

```bash
cd apps/web && vercel link
vercel env add DATABASE_URL production
vercel env add TM_API_KEY production
vercel env add SG_CLIENT_ID production
vercel --prod
```

**Monorepo settings**: root directory `apps/web`.

## Step 5: End-to-end verification

- [ ] Open prod URL on phone: trending grid renders seeded events.
- [ ] Track one event; confirm row in `watchlist_events` and `event_source_state` has both sources (if SG matched).
- [ ] Wait ≥20 min; run `select count(*) from price_snapshots;` — count should be growing. Poll cadence: TM rows ~2h apart, SG ~1h.
- [ ] Verify `robots.txt` is served; event page has `noindex` meta.

## Manual follow-up: Ticketmaster attribution logo

The footer (`apps/web/src/app/layout.tsx`) references `/tm-logo.svg`, which is **not** in the
repo — spec §2 requires the *official* Ticketmaster brand mark, and no fabricated logo may be
committed. Before launch, download the official asset from Ticketmaster's brand/attribution
guidelines and save it as `apps/web/public/tm-logo.svg` (or `.png`, updating the `<img src>`).
Until then the footer shows the image `alt` text.

## Step 6: Commit runbook + share

```bash
git add docs/DEPLOY.md && git commit -m "docs: deploy runbook" && git push
```

Send friend the URL. 🦏
