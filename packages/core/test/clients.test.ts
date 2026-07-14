import { expect, test, vi } from "vitest";
import { fetchWithBackoff } from "../src/backoff";
import { tmClient } from "../src/tm";
import { sgClient } from "../src/sg";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("fetchWithBackoff retries 429 then succeeds", async () => {
  const f = vi.fn()
    .mockResolvedValueOnce(json({}, 429))
    .mockResolvedValueOnce(json({ ok: true }));
  const res = await fetchWithBackoff(f, "https://x", undefined, 3, 1);
  expect(res.status).toBe(200);
  expect(f).toHaveBeenCalledTimes(2);
});

test("fetchWithBackoff gives up after tries and returns last response", async () => {
  const f = vi.fn().mockResolvedValue(json({}, 503));
  const res = await fetchWithBackoff(f, "https://x", undefined, 3, 1);
  expect(res.status).toBe(503);
  expect(f).toHaveBeenCalledTimes(3);
});

test("tm search parses Discovery payload and always sends countryCode=US", async () => {
  const f = vi.fn().mockResolvedValue(json({
    _embedded: { events: [{
      id: "tm123", name: "SZA — SOS Tour",
      dates: { start: { dateTime: "2026-08-21T20:00:00Z" }, timezone: "America/New_York", status: { code: "onsale" } },
      priceRanges: [{ min: 79, max: 350 }],
      classifications: [{ genre: { name: "R&B" } }],
      images: [{ url: "https://img/1.jpg", width: 1024 }],
      _embedded: { venues: [{ name: "Madison Square Garden", city: { name: "New York" } }],
                   attractions: [{ name: "SZA" }] },
    }] },
  }));
  const tm = tmClient("KEY", f);
  const [ev] = await tm.search("sza");
  expect(f.mock.calls[0][0]).toContain("countryCode=US");
  expect(ev).toMatchObject({ tmId: "tm123", artist: "SZA", venue: "Madison Square Garden",
    priceLow: 79, priceHigh: 350, genre: "R&B" });
});

test("sg getEventStats maps stats fields, null on 404", async () => {
  const f = vi.fn()
    .mockResolvedValueOnce(json({ id: 55, stats: { lowest_price: 94, average_price: 187, highest_price: 890, listing_count: 312 } }))
    .mockResolvedValueOnce(json({}, 404));
  const sg = sgClient("CID", f);
  expect(await sg.getEventStats("55")).toMatchObject({ sgId: "55", priceLow: 94, priceAvg: 187, priceHigh: 890, listingCount: 312 });
  expect(await sg.getEventStats("55")).toBeNull();
});
