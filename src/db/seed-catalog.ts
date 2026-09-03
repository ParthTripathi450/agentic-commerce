import { config as loadEnv } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { applyExpansion } from "./expansion";
import { GENERATED_MERCHANTS } from "./catalog-blueprints";
import { generateCatalogue } from "./catalog-generator";

loadEnv({ path: ".env.local", quiet: true });

/**
 * The generated catalogue, applied additively.
 *
 * Deterministic: same seed, same products, so an eval set built against this
 * data stays valid across re-runs. Safe to re-run — existing products are
 * skipped by title.
 */
async function main() {
  const sqlClient = postgres(process.env.DATABASE_URL!, { max: 1 });
  const db = drizzle(sqlClient, { schema });

  const products = generateCatalogue({ merchantSlugs: GENERATED_MERCHANTS });
  console.log(`generated ${products.length} specs → ${products.reduce((s, p) => s + p.merchants.length, 0)} product rows`);

  const result = await applyExpansion({
    db,
    merchants: [],
    products,
    orderPrefix: "ACG",
    randomSeed: 20260903,
    historyDays: 90,
  });

  const [{ count: productCount }] = await sqlClient<{ count: string }[]>`SELECT count(*) FROM products`;
  const [{ count: variantCount }] = await sqlClient<{ count: string }[]>`SELECT count(*) FROM product_variants`;

  console.log(`
added:
  products   ${result.productsAdded}
  variants   ${result.variantsAdded}
  orders     ${result.ordersAdded}

marketplace now: ${productCount} products, ${variantCount} variants

next: npm run db:seed-reviews && npm run catalog:index
`);
  await sqlClient.end();
}

main().catch((error) => { console.error(error); process.exit(1); });
