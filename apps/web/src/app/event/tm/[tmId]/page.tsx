import type { Metadata } from "next";
import { getClients } from "@/lib/clients";
import { PriceRows } from "@/components/PriceRows";
import { TrackButton } from "@/components/TrackButton";

export const revalidate = 0;
export const metadata: Metadata = { robots: { index: false } };

// spec §8: untracked search result — live TM render, NO DB row until Track
export default async function LiveEventPage({ params }: { params: Promise<{ tmId: string }> }) {
  const { tmId } = await params;
  const ev = await getClients().tm.getEvent(tmId);
  if (!ev) return <p className="mt-8 text-center text-gray-400">Event not found</p>;
  return (
    <div className="space-y-4">
      <div className="glass-card relative h-32 overflow-hidden bg-gradient-to-br from-violet-900 via-violet-600 to-teal-400"
        style={ev.artworkUrl ? { backgroundImage: `url(${ev.artworkUrl})`, backgroundSize: "cover" } : undefined}>
        <div className="absolute bottom-2 left-3">
          <h1 className="headline-serif text-xl font-bold text-white drop-shadow">{ev.name}</h1>
          <p className="text-[11px] text-indigo-100">{ev.venue} · {ev.startsAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</p>
        </div>
      </div>
      <PriceRows primary={ev.priceLow != null ? { low: String(ev.priceLow), high: String(ev.priceHigh) } : null} resale={null} />
      <p className="text-center text-xs text-gray-400">Track to start collecting price history</p>
      <TrackButton tmId={tmId} tracked={false} />
    </div>
  );
}
