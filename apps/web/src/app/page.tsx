import { asc, eq, and } from "drizzle-orm";
import Link from "next/link";
import { schema } from "@ticketrhino/core";
import { getClients } from "@/lib/clients";
import { EventCard } from "@/components/EventCard";
import { eventCards } from "@/lib/cards";

export const revalidate = 0;

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
