import type { SnapPoint } from "@ticketrhino/core";

// dimmed bars, emerald recent bars with glow (H1 system). Hidden (<48h) handled by caller.
export function HistoryChart({ points }: { points: SnapPoint[] }) {
  const max = Math.max(...points.map((p) => p.priceLow));
  return (
    <div className="flex h-14 items-end gap-[3px]">
      {points.map((p, i) => {
        const recent = i >= points.length - 2;
        return (
          <div key={p.pollBucket.getTime()}
            className={`flex-1 rounded-[2px] ${recent ? "glow-emerald" : ""}`}
            style={{
              height: `${(p.priceLow / max) * 100}%`,
              background: recent ? "var(--emerald)" : "rgba(255,255,255,.08)",
            }} />
        );
      })}
    </div>
  );
}
