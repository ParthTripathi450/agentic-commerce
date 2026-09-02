import { config as loadEnv } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { applyExpansion } from "./expansion";
import { SHOE_MERCHANTS, SHOE_PRODUCTS } from "./seed-shoes-data";

loadEnv({ path: ".env.local", quiet: true });

/**
 * Footwear depth, applied additively.
 *
 * Safe to re-run: existing merchants and products are skipped.
 */
async function main() {
  const sqlClient = postgres(process.env.DATABASE_URL!, { max: 1 });
  const db = drizzle(sqlClient, { schema });

  const result = await applyExpansion({
    db,
    merchants: SHOE_MERCHANTS,
    products: SHOE_PRODUCTS,
    orderPrefix: "ACF",
    randomSeed: 20260903,
    historyDays: 75,
  });

  const [{ count: shoeCount }] = await sqlClient<{ count: string }[]>`
    SELECT count(*) FROM products WHERE category IN (
      'Running Shoes','Trail Shoes','Sneakers','Football Boots','Cricket Shoes',
      'Basketball Shoes','Formal Shoes','Hiking Boots','Training Shoes',
      'Walking Shoes','Kids Shoes','Sandals')`;
  const [{ count: productCount }] = await sqlClient<{ count: string }[]>`SELECT count(*) FROM products`;

  console.log(`
added:
  merchants  ${result.merchantsAdded}
  products   ${result.productsAdded}
  variants   ${result.variantsAdded}
  orders     ${result.ordersAdded}

marketplace now:
  footwear   ${shoeCount}
  products   ${productCount}

next: npm run catalog:index && npm run catalog:images
`);

  await sqlClient.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
