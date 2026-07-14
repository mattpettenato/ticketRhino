import { fetchWithBackoff, type FetchBudget } from "./backoff";

export type TmEvent = {
  tmId: string; name: string; artist: string | null; venue: string | null;
  city: string | null; eventTz: string | null; startsAt: Date; artworkUrl: string | null;
  genre: string | null; priceLow: number | null; priceHigh: number | null; status: string;
};

const BASE = "https://app.ticketmaster.com/discovery/v2";

function parseEvent(e: any): TmEvent | null {
  const dateTime = e?.dates?.start?.dateTime;
  if (!e?.id || !e?.name || !dateTime) return null; // skip garbage, never throw (spec §9)
  const venue = e._embedded?.venues?.[0];
  const img = (e.images ?? []).sort((a: any, b: any) => (b.width ?? 0) - (a.width ?? 0))[0];
  return {
    tmId: e.id, name: e.name,
    artist: e._embedded?.attractions?.[0]?.name ?? null,
    venue: venue?.name ?? null, city: venue?.city?.name ?? null,
    eventTz: e.dates?.timezone ?? null, startsAt: new Date(dateTime),
    artworkUrl: img?.url ?? null,
    genre: e.classifications?.[0]?.genre?.name ?? null,
    priceLow: e.priceRanges?.[0]?.min ?? null, priceHigh: e.priceRanges?.[0]?.max ?? null,
    status: e.dates?.status?.code ?? "onsale",
  };
}

export function tmClient(apiKey: string, fetchFn: typeof fetch = fetch) {
  const get = async (path: string, params: Record<string, string>, budget?: FetchBudget) => {
    const qs = new URLSearchParams({ ...params, countryCode: "US", apikey: apiKey });
    const res = await fetchWithBackoff(fetchFn, `${BASE}${path}?${qs}`, undefined, 3, 500, budget);
    if (!res || !res.ok) return null;
    return res.json() as Promise<any>;
  };
  return {
    async getEvent(tmId: string, budget?: FetchBudget): Promise<TmEvent | null> {
      const body = await get(`/events/${encodeURIComponent(tmId)}.json`, {}, budget);
      return body ? parseEvent(body) : null;
    },
    async search(keyword: string): Promise<TmEvent[]> {
      const body = await get("/events.json", { keyword, size: "20", sort: "relevance,desc" });
      return (body?._embedded?.events ?? []).map(parseEvent).filter(Boolean) as TmEvent[];
    },
    async popular(size: number, budget?: FetchBudget): Promise<TmEvent[]> {
      const body = await get("/events.json", { size: String(size), sort: "relevance,desc" }, budget);
      return (body?._embedded?.events ?? []).map(parseEvent).filter(Boolean) as TmEvent[];
    },
  };
}
