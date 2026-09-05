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
      /*
       * A serverless instance handles one request at a time, so a pool of ten
       * is nine idle connections multiplied by however many instances are warm
       * — and the free tier counts every one of them. `VERCEL` is set by the
       * platform itself, so nothing has to be configured for this to be right.
       */
      max: process.env.VERCEL ? 1 : process.env.NODE_ENV === "production" ? 10 : 3,
      // Supabase's transaction-mode pooler does not support prepared statements.
      prepare: false,
      /*
       * A pooled connection that outlives the instance holding it is a
       * connection the pooler cannot reuse. Short idle timeouts matter far more
       * on serverless than they do on a long-lived server.
       */
      idle_timeout: process.env.VERCEL ? 20 : undefined,
      connect_timeout: 15,
    });
  }
  return globalForDb.__acpSql;
}

export const db = drizzle(client(), { schema });
export { schema };
export type Db = typeof db;
