import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/schema";

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:test@localhost:5433/postgres";

export function testDb() {
  return drizzle(TEST_DB_URL, { schema });
}
