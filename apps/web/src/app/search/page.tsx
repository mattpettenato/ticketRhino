import { inArray } from "drizzle-orm";
import { schema } from "@ticketrhino/core";
import { getClients } from "@/lib/clients";
import { CardData, EventCard } from "@/components/EventCard";

export const dynamic = "force-dynamic";

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  if (!q) return <p className="label-caps">SEARCH ARTIST, EVENT, VENUE</p>;
  const { db, tm } = getClients();
  const results = await tm.search(q); // server-side, Next fetch cache handles 5-min TTL via revalidate on fetch
  if (!results.length) return <p className="mt-8 text-center text-gray-400">Nothing found — try artist or venue name</p>;

  // merge rule (spec §8): key by tm_id, overlay local rows only
  const local = await db.select().from(schema.events)
    .where(inArray(schema.events.tmId, results.map((r) => r.tmId)));
  const byTmId = new Map(local.map((e) => [e.tmId, e]));

  const cards: CardData[] = results.map((r) => {
    const l = byTmId.get(r.tmId);
    return {
      href: l ? `/event/${l.id}` : `/event/tm/${r.tmId}`,
      name: r.name, venue: r.venue,
      dateLabel: r.startsAt.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      artworkUrl: r.artworkUrl,
      price: r.priceLow != null ? `$${r.priceLow}` : null, delta: null,
    };
  });
  return <div>{cards.map((c) => <EventCard key={c.href} ev={c} />)}</div>;
}
