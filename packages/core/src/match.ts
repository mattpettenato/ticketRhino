import { and, eq, isNull, or } from "drizzle-orm";
import { events, eventSourceState } from "./schema";
import type { FetchBudget } from "./backoff";
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
  db: any, eventId: number, sg: ReturnType<typeof sgClient>, budget?: FetchBudget,
): Promise<boolean> {
  const [ev] = await db.select().from(events).where(eq(events.id, eventId));
  if (!ev || ev.sgId) return !!ev?.sgId;
  const candidates = await sg.searchCandidates(ev.artist ?? ev.name, ev.startsAt, budget);
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
