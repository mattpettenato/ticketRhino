"use client";
import { useState, useTransition } from "react";
import { trackAction, untrackAction } from "@/app/actions";

export function TrackButton({ tmId, eventId, tracked }: { tmId: string; eventId?: number; tracked: boolean }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [isTracked, setTracked] = useState(tracked);
  return (
    <div>
      <button
        disabled={pending}
        onClick={() => start(async () => {
          if (isTracked && eventId != null) { await untrackAction(eventId); setTracked(false); return; }
          const res = await trackAction(tmId);
          if (res.ok) setTracked(true); else setMsg(res.message ?? "Failed");
        })}
        className="w-full rounded-xl py-3 text-sm font-extrabold"
        style={{ background: "linear-gradient(90deg,#059669,var(--emerald))", color: "#022c22" }}>
        {pending ? "…" : isTracked ? "✓ Tracking — tap to untrack" : "＋ Track this event"}
      </button>
      {msg && <p className="mt-2 text-center text-xs" style={{ color: "var(--red)" }}>{msg}</p>}
    </div>
  );
}
