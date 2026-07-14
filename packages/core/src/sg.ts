import { fetchWithBackoff } from "./backoff";

export type SgStats = {
  sgId: string; priceLow: number | null; priceAvg: number | null;
  priceHigh: number | null; listingCount: number | null;
};
export type SgCandidate = { sgId: string; title: string; venue: string | null; startsAt: Date; stats: SgStats };

const BASE = "https://api.seatgeek.com/2";

function parseStats(e: any): SgStats {
  return {
    sgId: String(e.id),
    priceLow: e.stats?.lowest_price ?? null,
    priceAvg: e.stats?.average_price ?? null,
    priceHigh: e.stats?.highest_price ?? null,
    listingCount: e.stats?.listing_count ?? null,
  };
}

export function sgClient(clientId: string, fetchFn: typeof fetch = fetch) {
  const get = async (path: string, params: Record<string, string>) => {
    const qs = new URLSearchParams({ ...params, client_id: clientId });
    const res = await fetchWithBackoff(fetchFn, `${BASE}${path}?${qs}`);
    if (!res.ok) return null;
    return res.json() as Promise<any>;
  };
  return {
    async getEventStats(sgId: string): Promise<SgStats | null> {
      const body = await get(`/events/${encodeURIComponent(sgId)}`, {});
      return body?.id ? parseStats(body) : null;
    },
    async searchCandidates(artistOrName: string, around: Date): Promise<SgCandidate[]> {
      const day = 86_400_000;
      const gte = new Date(around.getTime() - day).toISOString().slice(0, 10);
      const lte = new Date(around.getTime() + day).toISOString().slice(0, 10);
      const body = await get("/events", {
        q: artistOrName, "datetime_utc.gte": gte, "datetime_utc.lte": lte, per_page: "10",
      });
      return (body?.events ?? [])
        .filter((e: any) => e?.id && e?.datetime_utc)
        .map((e: any) => ({
          sgId: String(e.id), title: e.title ?? "",
          venue: e.venue?.name ?? null, startsAt: new Date(e.datetime_utc + "Z"),
          stats: parseStats(e),
        }));
    },
  };
}
