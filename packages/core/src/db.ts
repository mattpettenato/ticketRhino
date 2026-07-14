import { neon, Pool } from "@neondatabase/serverless";
import { drizzle as drizzleHttp } from "drizzle-orm/neon-http";
import { drizzle as drizzlePool } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

// Worker + web reads: one HTTP subrequest per statement, no sessions.
export function dbHttp(url: string) {
  return drizzleHttp(neon(url), { schema });
}

// Web Track transaction only: WebSocket pool supports interactive transactions.
export function dbPool(url: string) {
  return drizzlePool(new Pool({ connectionString: url }), { schema });
}
