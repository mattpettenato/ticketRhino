import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = { title: "TicketRhino", description: "Know when to buy." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="mx-auto max-w-2xl px-4 pb-16">
        <header className="flex items-center justify-between py-5">
          <Link href="/" className="text-lg font-black tracking-tight text-white">
            🦏 Ticket<span style={{ color: "var(--emerald)" }}>Rhino</span>
          </Link>
          <Link href="/watchlist" className="text-sm" style={{ color: "var(--peri)" }}>Watchlist</Link>
        </header>
        {children}
        <footer className="mt-16 flex flex-col items-center gap-2 text-center text-xs text-gray-500">
          {/* spec §2 mandatory ToS attribution. /tm-logo.svg must hold the OFFICIAL Ticketmaster
              brand asset — see docs/DEPLOY.md follow-up; do not substitute a redrawn logo. */}
          <a href="https://www.ticketmaster.com" aria-label="Ticketmaster">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/tm-logo.svg" alt="Ticketmaster" height={16} className="h-4 w-auto" />
          </a>
          <div>
            Event data by{" "}
            <a href="https://www.ticketmaster.com" className="underline">Ticketmaster</a> · resale stats by{" "}
            <a href="https://seatgeek.com" className="underline">SeatGeek</a>. Non-commercial project.
          </div>
        </footer>
      </body>
    </html>
  );
}
