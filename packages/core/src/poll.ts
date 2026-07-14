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
  const values = sql.join(results.map((r) => sql`(${r.eventId}::integer, ${r.source}::text, ${r.ok}::boolean)`), sql`, `);
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
