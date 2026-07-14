import { dbHttp, dbPool, schema, sgClient, tmClient } from "@ticketrhino/core";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "./env";

// Playwright e2e points the web app at local docker Postgres, which Neon's HTTP
// driver can't reach. This swap lives here (Node-only runtime, never bundled for
// Workers) so core stays driver-agnostic.
function isLocalDatabase(url: string): boolean {
  return url.includes("localhost") || url.includes("127.0.0.1");
}

export function getClients() {
  const e = env();
  // Local e2e only: one node-postgres drizzle serves both reads and transactions
  // (node-postgres supports interactive transactions directly).
  const localDb = isLocalDatabase(e.DATABASE_URL)
    ? drizzleNodePg(new pg.Pool({ connectionString: e.DATABASE_URL }), { schema })
    : undefined;
  return {
    // Cast keeps one return type; the node-postgres path exists only for local e2e.
    db: (localDb ?? dbHttp(e.DATABASE_URL)) as ReturnType<typeof dbHttp>,
    dbTx: () => (localDb ?? dbPool(e.DATABASE_URL)) as unknown as ReturnType<typeof dbPool>, // interactive transactions (Track only)
    tm: tmClient(e.TM_API_KEY, (url, init) => fetch(url, { ...init, next: { revalidate: 300 } })),
    sg: sgClient(e.SG_CLIENT_ID),
  };
}
