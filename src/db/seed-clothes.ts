import { config as loadEnv } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { applyExpansion } from "./expansion";
import { CLOTHES_MERCHANTS, CLOTHES_PRODUCTS } from "./seed-clothes-data";

loadEnv({ path: ".env.local", quiet: true });

/** Apparel depth, applied additively. Safe to re-run. */
async function main() {
  const sqlClient = postgres(process.env.DATABASE_URL!, { max: 1 });
  const db = drizzle(sqlClient, { schema });

  const result = await applyExpansion({
    db,
    merchants: CLOTHES_MERCHANTS,
    products: CLOTHES_PRODUCTS,
    orderPrefix: "ACC",
    randomSeed: 20260904,
    historyDays: 70,
  });

  const [{ count: productCount }] = await sqlClient<{ count: string }[]>`SELECT count(*) FROM products`;
  console.log(`
added:
  merchants  ${result.merchantsAdded}
  products   ${result.productsAdded}
  variants   ${result.variantsAdded}
  orders     ${result.ordersAdded}

marketplace now: ${productCount} products

next: npm run catalog:index && npm run catalog:images
`);
  await sqlClient.end();
}

main().catch((error) => { console.error(error); process.exit(1); });
