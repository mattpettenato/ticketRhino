import { dbHttp, dbPool, sgClient, tmClient } from "@ticketrhino/core";
import { env } from "./env";

export function getClients() {
  const e = env();
  return {
    db: dbHttp(e.DATABASE_URL),
    dbTx: () => dbPool(e.DATABASE_URL), // interactive transactions (Track only)
    tm: tmClient(e.TM_API_KEY, (url, init) => fetch(url, { ...init, next: { revalidate: 300 } })),
    sg: sgClient(e.SG_CLIENT_ID),
  };
}
