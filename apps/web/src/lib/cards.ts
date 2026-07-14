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
      price: latest ? `$${latest.priceLow.toFixed(2)}` : null,
      delta: delta24h(points, now),
    };
  }));
}
