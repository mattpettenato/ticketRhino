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
        <footer className="mt-16 text-center text-xs text-gray-500">
          Event data by{" "}
          <a href="https://www.ticketmaster.com" className="underline">Ticketmaster</a> · resale stats by{" "}
          <a href="https://seatgeek.com" className="underline">SeatGeek</a>. Non-commercial project.
        </footer>
      </body>
    </html>
  );
}
