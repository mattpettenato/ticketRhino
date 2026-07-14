import { neon, Pool } from "@neondatabase/serverless";
import { drizzle as drizzleHttp } from "drizzle-orm/neon-http";
import { drizzle as drizzlePool } from "drizzle-orm/neon-serverless";
import { drizzle as drizzeNodePg } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

// Check if URL is for local postgres or Neon
function isLocalDatabase(url: string): boolean {
  return url.includes("localhost") || url.includes("127.0.0.1");
}

// Worker + web reads: one HTTP subrequest per statement, no sessions.
// For local databases, uses node-postgres driver.
export function dbHttp(url: string) {
  if (isLocalDatabase(url)) {
    const pool = new pg.Pool({ connectionString: url });
    return drizzeNodePg(pool, { schema });
  }
  return drizzleHttp(neon(url), { schema });
}

// Web Track transaction only: WebSocket pool supports interactive transactions.
export function dbPool(url: string) {
  return drizzlePool(new Pool({ connectionString: url }), { schema });
}
