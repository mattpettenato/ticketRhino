type Primary = { low: string | null; high: string | null } | null;
type Resale = { low: string | null; avg: string | null; high: string | null; listings: number | null } | null;

// spec §2: two labeled rows, never a combined winner
export function PriceRows({ primary, resale }: { primary: Primary; resale: Resale }) {
  return (
    <div className="space-y-2">
      <div className="glass-card flex items-center justify-between p-3">
        <div>
          <div className="label-caps">PRIMARY · TICKETMASTER</div>
          <div className="text-[10px] text-gray-500">face value range</div>
        </div>
        <div className="price-mono text-[15px] font-bold">
          {primary?.low != null ? `$${primary.low}–$${primary.high}` : "—"}
        </div>
      </div>
      <div className="glass-card flex items-center justify-between p-3"
        style={{ borderColor: "rgba(52,211,153,.35)", background: "rgba(52,211,153,.07)" }}>
        <div>
          <div className="label-caps" style={{ color: "var(--emerald)" }}>RESALE · SEATGEEK</div>
          <div className="text-[10px] text-gray-500">
            {resale ? `${resale.listings ?? "?"} listings` : "no resale data yet"}
          </div>
        </div>
        {resale && (
          <div className="text-right">
            <div className="price-mono text-[15px] font-bold" style={{ color: "var(--emerald)" }}>from ${resale.low}</div>
            <div className="price-mono text-[10px] text-gray-500">avg ${resale.avg} · high ${resale.high}</div>
          </div>
        )}
      </div>
    </div>
  );
}
