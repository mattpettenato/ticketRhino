import { and, asc, eq, gte } from "drizzle-orm";
import { cookies } from "next/headers";
import type { Metadata } from "next";
import { delta24h, isLowest30d, schema, SnapPoint, weekDelta } from "@ticketrhino/core";
import { getClients } from "@/lib/clients";
import { HistoryChart } from "@/components/HistoryChart";
import { PriceRows } from "@/components/PriceRows";
import { TrackButton } from "@/components/TrackButton";

export const revalidate = 0;
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
