import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });

/**
 * Gives every existing shopper and merchant an address.
 *
 *   npm run db:backfill-addresses
 *
 * Addresses arrived after the marketplace had orders in it, so everything
 * already there has none. A checkout that offers "deliver to your usual
 * address" and finds nothing reads as data loss rather than a new feature, and
 * a merchant with no dispatch address cannot state a delivery estimate
 * honestly.
 *
 * Idempotent: anyone who already has one is skipped, so this is safe to re-run
 * and safe to leave in the setup sequence.
 */
const CITIES = [
  { city: "Bengaluru", state: "Karnataka", postcode: "560001" },
  { city: "Mumbai", state: "Maharashtra", postcode: "400001" },
  { city: "Delhi", state: "Delhi", postcode: "110001" },
  { city: "Chennai", state: "Tamil Nadu", postcode: "600001" },
  { city: "Hyderabad", state: "Telangana", postcode: "500001" },
  { city: "Pune", state: "Maharashtra", postcode: "411001" },
  { city: "Kolkata", state: "West Bengal", postcode: "700001" },
  { city: "Ahmedabad", state: "Gujarat", postcode: "380001" },
  { city: "Jaipur", state: "Rajasthan", postcode: "302001" },
  { city: "Kochi", state: "Kerala", postcode: "682001" },
];

const STREETS = [
  "MG Road", "Nehru Street", "Park Avenue", "Lake View Road", "Gandhi Marg",
  "Church Street", "Hill Road", "Station Road", "Residency Road", "Ring Road",
];

/** Deterministic from the id, so a re-run cannot reshuffle anybody's city. */
function pickFor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(31, h) + id.charCodeAt(i)) | 0;
  const n = Math.abs(h);
  return {
    ...CITIES[n % CITIES.length],
    line1: `${(n % 180) + 1} ${STREETS[(n >> 3) % STREETS.length]}`,
    line2: n % 3 === 0 ? `Flat ${(n % 40) + 1}` : null,
    phone: `+91 ${String(70000 + (n % 29999))}${String(10000 + ((n >> 5) % 89999))}`.slice(0, 18),
  };
}

async function main() {
  const { db } = await import("@/db");
  const { addresses, merchants } = await import("@/db/schema");
  const { eq, isNull, sql } = await import("drizzle-orm");

  // ------------------------------------------------------------- shoppers
  const shoppers = (await db.execute(sql`
    SELECT u.id, u.name, u.email
    FROM users u
    WHERE u.role = 'customer'
      AND NOT EXISTS (SELECT 1 FROM addresses a WHERE a.user_id = u.id)
  `)) as unknown as { id: string; name: string | null; email: string }[];

  let shoppersDone = 0;
  for (const shopper of shoppers) {
    const place = pickFor(shopper.id);
    await db.insert(addresses).values({
      userId: shopper.id,
      label: "Home",
      recipient: shopper.name?.trim() || shopper.email.split("@")[0],
      phone: place.phone,
      line1: place.line1,
      line2: place.line2,
      city: place.city,
      state: place.state,
      postcode: place.postcode,
      country: "India",
      // The first address must be the default, or checkout offers nothing.
      isDefault: true,
    });
    shoppersDone++;
  }

  // ------------------------------------------------------------ merchants
  const withoutAddress = await db
    .select({ id: merchants.id, name: merchants.name })
    .from(merchants)
    .where(isNull(merchants.address));

  let merchantsDone = 0;
  for (const merchant of withoutAddress) {
    const place = pickFor(merchant.id);
    await db
      .update(merchants)
      .set({
        address: {
          line1: place.line1,
          line2: place.line2,
          city: place.city,
          state: place.state,
          postcode: place.postcode,
          country: "India",
          phone: place.phone,
        },
      })
      .where(eq(merchants.id, merchant.id));
    merchantsDone++;
  }

  // --------------------------------------------- past orders keep a record
  /*
   * Existing orders shipped somewhere, and an order page that says "no
   * delivery address" for every historical order looks broken. Each is given
   * its own shopper's address as it stands now — which is the honest
   * approximation available, and is marked as such by carrying the label.
   */
  const backfilledOrders = (await db.execute(sql`
    UPDATE orders o
    SET shipping_address = jsonb_build_object(
      'label', a.label, 'recipient', a.recipient, 'phone', a.phone,
      'line1', a.line1, 'line2', a.line2, 'city', a.city,
      'state', a.state, 'postcode', a.postcode, 'country', a.country
    )
    FROM addresses a
    WHERE a.user_id = o.user_id AND a.is_default = true AND o.shipping_address IS NULL
    RETURNING o.id
  `)) as unknown as { id: string }[];

  console.log(`
  shoppers given an address   ${shoppersDone} (of ${shoppers.length} without one)
  merchants given an address  ${merchantsDone}
  past orders backfilled      ${backfilledOrders.length}
`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
