import { config as loadEnv } from "dotenv";
import postgres from "postgres";

loadEnv({ path: ".env.local", quiet: true });

/** Truncates every application table, leaving the schema and migrations intact. */
export async function truncateAll(sql: postgres.Sql) {
  const rows = await sql<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'
  `;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  await sql.unsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    await truncateAll(sql);
    console.log("all tables truncated");
  } finally {
    await sql.end();
  }
}

if (process.argv[1]?.endsWith("reset.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
