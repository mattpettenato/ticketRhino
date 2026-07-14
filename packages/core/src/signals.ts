// All windows are rolling UTC intervals from `now` (spec §7). Resale price_low only.
export type SnapPoint = { pollBucket: Date; priceLow: number };

const DAY = 86_400_000;

export function historySpanDays(points: SnapPoint[]): number {
  if (points.length < 2) return 0;
  return (points[points.length - 1].pollBucket.getTime() - points[0].pollBucket.getTime()) / DAY;
}

function inWindow(points: SnapPoint[], now: Date, days: number): SnapPoint[] {
  const cutoff = now.getTime() - days * DAY;
  return points.filter((p) => p.pollBucket.getTime() >= cutoff);
}

export function weekDelta(points: SnapPoint[], now: Date): number | null {
  if (historySpanDays(points) < 7) return null;
  const latest = points[points.length - 1];
  const target = now.getTime() - 7 * DAY;
  // bucket closest to now - 7d
  const ref = points.reduce((best, p) =>
    Math.abs(p.pollBucket.getTime() - target) < Math.abs(best.pollBucket.getTime() - target) ? p : best,
  );
  if (ref.priceLow === 0) return null;
  return (latest.priceLow - ref.priceLow) / ref.priceLow;
}

export function isLowest30d(points: SnapPoint[], now: Date): boolean | null {
  if (historySpanDays(points) < 14) return null;
  const window = inWindow(points, now, 30);
  const latest = window[window.length - 1];
  return latest.priceLow <= Math.min(...window.map((p) => p.priceLow));
}

export function delta24h(points: SnapPoint[], now: Date): number | null {
  const window = inWindow(points, now, 1);
  if (window.length < 2) return null;
  const oldest = window[0];
  const latest = window[window.length - 1];
  if (latest.pollBucket.getTime() - oldest.pollBucket.getTime() < 20 * 3_600_000) return null;
  if (oldest.priceLow === 0) return null;
  return (latest.priceLow - oldest.priceLow) / oldest.priceLow;
}
