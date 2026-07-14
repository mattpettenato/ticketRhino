"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { trackEvent, untrackEvent } from "@ticketrhino/core";
import { getClients } from "@/lib/clients";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Validate the anon cookie is a well-formed UUID before it reaches SQL — it's attacker-controlled.
function anonId(id: string | undefined): string | null {
  return id && UUID_RE.test(id) ? id : null;
}

export async function trackAction(tmId: string): Promise<{ ok: boolean; message?: string; eventId?: number }> {
  const anon = anonId((await cookies()).get("rhino_anon")?.value);
  if (!anon) return { ok: false, message: "No session" };
  const { dbTx, tm, sg } = getClients();
  const ev = await tm.getEvent(tmId);
  if (!ev) return { ok: false, message: "Event unavailable" };
  const res = await trackEvent(dbTx(), anon, ev, sg);
  if (!res.ok) return { ok: false, message: "Watchlist full — untrack something first" };
  revalidatePath("/watchlist");
  return { ok: true, eventId: res.eventId }; // returned so a TM-page TrackButton can untrack
}

export async function untrackAction(eventId: number) {
  const anon = anonId((await cookies()).get("rhino_anon")?.value);
  if (!anon) return;
  await untrackEvent(getClients().dbTx(), anon, eventId);
  revalidatePath("/watchlist");
}
