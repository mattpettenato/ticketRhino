import { eq, inArray } from "drizzle-orm";
import { cookies } from "next/headers";
import Link from "next/link";
import { schema } from "@ticketrhino/core";
import { getClients } from "@/lib/clients";
import { EventCard } from "@/components/EventCard";
import { eventCards } from "@/lib/cards";

export const revalidate = 0;

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
