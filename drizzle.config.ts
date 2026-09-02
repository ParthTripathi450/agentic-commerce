import { config as loadEnv } from "dotenv";
import type { Config } from "drizzle-kit";

loadEnv({ path: ".env.local", quiet: true });

export default {
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
  strict: true,
  verbose: true,
} satisfies Config;
