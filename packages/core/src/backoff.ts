export type FetchBudget = { remaining: number };

// Shared per-run fetch budget: caps total external subrequests across ALL rows in a poll cycle
// so a 5xx episode can't blow the CF 50-subrequest limit via unbounded retries (45 rows × 3
// tries = 136 fetches otherwise). Each fetch — first attempt or retry — decrements the budget
// BEFORE it runs; when exhausted a row simply doesn't fetch (returns undefined → caller treats
// it as a failed poll, so per-row error accounting still runs). Omit `budget` for unbudgeted
// callers (track / search / nightly match), which keep the plain 3-try backoff.
export async function fetchWithBackoff(
  fetchFn: typeof fetch, url: string, opts?: RequestInit, tries = 3, baseMs = 500,
  budget?: FetchBudget,
): Promise<Response> {
  let res!: Response;
  for (let i = 0; i < tries; i++) {
    if (budget) {
      if (budget.remaining <= 0) break; // no subrequests left — do not fetch
      budget.remaining--;
    }
    res = await fetchFn(url, opts);
    if (res.status !== 429 && res.status < 500) return res;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
  }
  return res;
}
