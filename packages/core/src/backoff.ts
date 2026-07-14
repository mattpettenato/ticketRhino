export async function fetchWithBackoff(
  fetchFn: typeof fetch, url: string, opts?: RequestInit, tries = 3, baseMs = 500,
): Promise<Response> {
  let res!: Response;
  for (let i = 0; i < tries; i++) {
    res = await fetchFn(url, opts);
    if (res.status !== 429 && res.status < 500) return res;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
  }
  return res;
}
