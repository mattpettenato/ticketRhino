import Link from "next/link";

export type CardData = {
  href: string; name: string; venue: string | null; dateLabel: string;
  artworkUrl: string | null; price: string | null; delta: number | null;
};

export function EventCard({ ev }: { ev: CardData }) {
  const deltaColor = ev.delta == null ? undefined : ev.delta <= 0 ? "var(--emerald)" : "var(--red)";
  return (
    <Link href={ev.href} className="glass-card mb-3 flex items-center gap-3 p-3 transition hover:-translate-y-0.5">
      <div className="h-11 w-11 shrink-0 rounded-lg bg-gradient-to-br from-violet-900 to-violet-600"
        style={ev.artworkUrl ? { backgroundImage: `url(${ev.artworkUrl})`, backgroundSize: "cover" } : undefined} />
      <div className="min-w-0 flex-1">
        <div className="headline-serif truncate text-[15px] font-bold text-white">{ev.name}</div>
        <div className="text-[11px]" style={{ color: "var(--peri)" }}>{ev.venue} · {ev.dateLabel}</div>
      </div>
      <div className="text-right">
        {ev.price && <div className="price-mono text-[15px] font-bold" style={{ color: deltaColor ?? "#e5e7eb" }}>{ev.price}</div>}
        {ev.delta != null && (
          <div className="price-mono text-[10px]" style={{ color: deltaColor }}>
            {ev.delta <= 0 ? "▼" : "▲"} {Math.abs(ev.delta * 100).toFixed(0)}%
          </div>
        )}
      </div>
    </Link>
  );
}
