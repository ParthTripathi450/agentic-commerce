import { config as loadEnv } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

loadEnv({ path: ".env.local", quiet: true });

/**
 * Runs pending migrations. Extensions are created first because the generated
 * SQL references `vector` and `gen_random_uuid()` — both Supabase-safe.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const sql = postgres(url, { max: 1 });
  try {
    await sql.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
    await sql.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    console.log("migrations applied");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
