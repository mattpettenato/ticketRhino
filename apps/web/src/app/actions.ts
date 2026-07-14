"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { trackEvent, untrackEvent } from "@ticketrhino/core";
import { getClients } from "@/lib/clients";

export async function trackAction(tmId: string): Promise<{ ok: boolean; message?: string }> {
  const anonId = (await cookies()).get("rhino_anon")?.value;
  if (!anonId) return { ok: false, message: "No session" };
  const { dbTx, tm, sg } = getClients();
  const ev = await tm.getEvent(tmId);
  if (!ev) return { ok: false, message: "Event unavailable" };
  const res = await trackEvent(dbTx(), anonId, ev, sg);
  if (!res.ok) return { ok: false, message: "Watchlist full — untrack something first" };
  revalidatePath("/watchlist");
  return { ok: true };
}

export async function untrackAction(eventId: number) {
  const anonId = (await cookies()).get("rhino_anon")?.value;
  if (!anonId) return;
  await untrackEvent(getClients().dbTx(), anonId, eventId);
  revalidatePath("/watchlist");
}
