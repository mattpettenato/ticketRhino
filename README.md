# TicketRhino 🦏

Know when to buy. TicketRhino tracks Ticketmaster face-value prices and SeatGeek resale
stats for events you follow, and tells you when the resale price is at a 30-day low.

pnpm monorepo:

- `packages/core` — shared Drizzle schema, DB clients, TM/SeatGeek clients, polling + nightly
  jobs, matching, signals. Consumed raw (TypeScript) by both apps.
- `apps/worker` — Cloudflare Worker cron poller (10-min poll cycle + 5am nightly). No Node
  builtins may enter its bundle.
- `apps/web` — Next.js 16 front end (Node runtime) deployed to Vercel.

## Prerequisites

- Node 22, `pnpm`, Docker.
- `pnpm install`

## Local Postgres

Core tests and the local web e2e run against a Docker Postgres on port **5433**:

```bash
docker run -d --name trhino-pg -e POSTGRES_PASSWORD=test -p 5433:5432 postgres:16
# already created it once? just: docker start trhino-pg
```

## Migrate

```bash
cd packages/core
DATABASE_URL="postgresql://postgres:test@localhost:5433/postgres" pnpm exec drizzle-kit migrate
```

## Test

```bash
pnpm --filter @ticketrhino/core test   # vitest against the Docker Postgres above
pnpm --filter web test:e2e             # Playwright (starts the dev server on :3100)
```

## Dev

```bash
pnpm --filter web dev                   # Next.js dev server
pnpm --filter worker dev                # wrangler dev --test-scheduled
```

## Deploy

See [docs/DEPLOY.md](docs/DEPLOY.md).
