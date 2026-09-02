import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

/**
 * Postgres client.
 *
 * Cached on globalThis so Next.js hot reloads don't open a new pool per compile
 * — the Supabase free tier caps concurrent connections and will refuse them.
 */
const globalForDb = globalThis as unknown as {
  __acpSql?: ReturnType<typeof postgres>;
};

function client() {
  if (!globalForDb.__acpSql) {
    globalForDb.__acpSql = postgres(env().DATABASE_URL, {
      max: process.env.NODE_ENV === "production" ? 10 : 3,
      prepare: false, // Supabase transaction-mode pooler does not support prepared statements
    });
  }
  return globalForDb.__acpSql;
}

export const db = drizzle(client(), { schema });
export { schema };
export type Db = typeof db;
