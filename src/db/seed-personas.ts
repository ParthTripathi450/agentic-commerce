import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });

/**
 * Gives the marketplace shoppers who behave like people.
 *
 *   npm run db:seed-personas [-- --reset]
 *
 * Additive and idempotent: it creates its own `@personas.test` accounts and
 * never touches existing orders, because reviews cascade from orders.
 */
async function main() {
  const { seedPersonaShoppers, clearPersonaShoppers, PERSONAS } = await import("./personas");

  if (process.argv.includes("--reset")) {
    const removed = await clearPersonaShoppers();
    console.log(`cleared ${removed} persona shoppers and their orders\n`);
  }

  console.log(`seeding ${PERSONAS.length} personas…`);
  const result = await seedPersonaShoppers();

  console.log(`
  personas used     ${result.personasUsed}
  shoppers created  ${result.shoppersCreated}
  already present   ${result.shoppersExisting}
  orders added      ${result.ordersAdded}
`);
  console.log("run `npm run eval:for-you` to see whether the profile can now predict them.");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
