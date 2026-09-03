import { config as loadEnv } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import * as schema from "./schema";
import { clamp } from "./catalog-generator";
import { type QualityKey, type QualityScores } from "./catalog-blueprints";

loadEnv({ path: ".env.local", quiet: true });

/**
 * Gives the hand-written products the same quality vocabulary as the generated
 * ones.
 *
 * Backfilled rather than regenerated: 974 orders reference these rows, and the
 * co-purchase recommendations are built on that history. Deleting them to make
 * the dataset uniform would throw away the only real behavioural signal here.
 *
 * Scores are derived from what each product already SAYS — its category, and
 * the material and feature words in its own description. That keeps the
 * backfill honest: a product described as waterproof scores high on water
 * resistance because it claims to be, not because a script guessed.
 */

/** Category → the qualities that category is even measured on. */
const CATEGORY_BASE: Record<string, QualityScores> = {
  "Running Shoes": { comfort: 4, breathability: 3, grip: 3, durability: 3, support: 3, waterResistance: 2 },
  "Trail Shoes": { grip: 5, durability: 4, support: 4, comfort: 3, breathability: 3, waterResistance: 2 },
  "Court Shoes": { grip: 5, support: 4, stability: 4, durability: 4, comfort: 3, breathability: 3 },
  Sneakers: { comfort: 4, durability: 3, materialQuality: 3, breathability: 3, grip: 3 },
  "Hiking Boots": { durability: 5, support: 5, grip: 4, waterResistance: 3, comfort: 3, breathability: 2 },
  "Formal Shoes": { materialQuality: 5, durability: 4, comfort: 3, breathability: 2, grip: 2 },
  "Training Shoes": { stability: 5, durability: 4, grip: 4, support: 4, comfort: 3, breathability: 3 },
  "Walking Shoes": { comfort: 5, support: 4, durability: 3, breathability: 3, grip: 3 },
  "Football Boots": { grip: 5, durability: 4, support: 3, comfort: 3, breathability: 3 },
  "Cricket Shoes": { grip: 5, durability: 4, support: 4, comfort: 3 },
  "Basketball Shoes": { support: 5, grip: 4, stability: 4, durability: 4, comfort: 3 },
  "Kids Shoes": { durability: 4, comfort: 4, easeOfCare: 4, grip: 3, breathability: 3 },
  Sandals: { breathability: 5, comfort: 4, grip: 3, packability: 4, waterResistance: 3 },
  "T-Shirts": { comfort: 4, breathability: 4, easeOfCare: 4, durability: 3, materialQuality: 3 },
  Shirts: { comfort: 4, breathability: 3, materialQuality: 4, easeOfCare: 3, durability: 3 },
  Hoodies: { warmth: 4, comfort: 5, durability: 3, easeOfCare: 3, breathability: 2 },
  Knitwear: { warmth: 4, comfort: 4, materialQuality: 4, durability: 3, breathability: 3 },
  Jackets: { warmth: 4, waterResistance: 3, durability: 4, packability: 3, breathability: 2 },
  Coats: { warmth: 5, materialQuality: 4, durability: 4, waterResistance: 2, packability: 2 },
  "Base Layers": { warmth: 4, breathability: 4, comfort: 4, materialQuality: 4, packability: 4 },
  Jeans: { durability: 4, materialQuality: 4, comfort: 3, easeOfCare: 3, breathability: 2 },
  Trousers: { comfort: 4, durability: 3, easeOfCare: 4, materialQuality: 3, breathability: 3 },
  Activewear: { breathability: 5, comfort: 4, easeOfCare: 4, packability: 4, durability: 3 },
  Dresses: { comfort: 4, materialQuality: 4, breathability: 3, easeOfCare: 3 },
  Suits: { materialQuality: 5, comfort: 3, durability: 4, breathability: 3, easeOfCare: 2 },
  Socks: { comfort: 4, durability: 3, breathability: 4, easeOfCare: 4, warmth: 3 },
  Accessories: { comfort: 4, warmth: 3, materialQuality: 3, durability: 3, packability: 4 },
  Earbuds: { portability: 5, soundQuality: 3, batteryLife: 3, comfort: 3, noiseIsolation: 3 },
  Headphones: { soundQuality: 4, noiseIsolation: 4, batteryLife: 4, comfort: 4, portability: 2 },
  Speakers: { soundQuality: 4, portability: 4, batteryLife: 4, durability: 4, waterResistance: 3 },
  "Power Accessories": { portability: 4, durability: 3, batteryLife: 4 },
  "Fitness Accessories": { grip: 4, comfort: 4, durability: 3, portability: 3, easeOfCare: 4 },
  Cookware: { heatRetention: 3, durability: 3, easeOfCare: 3, materialQuality: 3, nonStick: 2 },
  "Kitchen Appliances": { durability: 3, easeOfCare: 3, materialQuality: 3, portability: 3 },
  Drinkware: { heatRetention: 4, durability: 4, portability: 4, easeOfCare: 3, materialQuality: 3 },
  Storage: { durability: 4, capacity: 4, easeOfCare: 3, portability: 3 },
  Stationery: { materialQuality: 3, durability: 3, portability: 4 },
  "Pet Furniture": { durability: 3, comfort: 4, easeOfCare: 3 },
};

const FALLBACK_BASE: QualityScores = { durability: 3, comfort: 3, materialQuality: 3, easeOfCare: 3 };

/**
 * Words in the product's own text that justify moving a score.
 *
 * Only ever applied to a quality the CATEGORY already measures, plus the few a
 * claim introduces outright — otherwise "waterproof" on a towel would invent a
 * water-resistance score for something where it means the opposite.
 */
const CLAIMS: Array<{ pattern: RegExp; shifts: QualityScores; introduces?: QualityKey[] }> = [
  { pattern: /\b(waterproof|water-resistant|gore-?tex|taped seams|membrane)\b/i,
    shifts: { waterResistance: 2, breathability: -1 }, introduces: ["waterResistance"] },
  { pattern: /\b(breathab\w+|mesh|ventilat\w+|airy|moisture-wicking)\b/i,
    shifts: { breathability: 2, waterResistance: -1 } },
  { pattern: /\b(leather|full-grain|calf|suede)\b/i,
    shifts: { materialQuality: 1, durability: 1, breathability: -1 } },
  { pattern: /\b(merino|cashmere|silk|lambswool)\b/i,
    shifts: { materialQuality: 2, comfort: 1, warmth: 1 } },
  { pattern: /\b(cushion\w+|plush|padded|max cushion|soft)\b/i, shifts: { comfort: 1 } },
  { pattern: /\b(lug|grip|traction|sticky rubber|non-?slip|studs|spikes)\b/i, shifts: { grip: 2 } },
  { pattern: /\b(reinforc\w+|ripstop|rugged|hard-?wearing|abrasion)\b/i, shifts: { durability: 1 } },
  { pattern: /\b(lightweight|packable|packs into|ultralight)\b/i,
    shifts: { packability: 2, portability: 1 }, introduces: ["packability", "portability"] },
  { pattern: /\b(insulat\w+|thermal|down|fleece|warm)\b/i,
    shifts: { warmth: 2 }, introduces: ["warmth"] },
  { pattern: /\b(stabilit\w+|support|guide rails|arch|structured)\b/i, shifts: { support: 1, stability: 1 } },
  { pattern: /\b(machine wash\w*|easy care|wipe clean|dishwasher)\b/i,
    shifts: { easeOfCare: 2 }, introduces: ["easeOfCare"] },
  { pattern: /\b(budget|entry-level|inexpensive|affordable|honest)\b/i,
    shifts: { materialQuality: -1, durability: -1 } },
  { pattern: /\b(premium|hand-|artisan|small runs|goodyear|half-canvassed)\b/i,
    shifts: { materialQuality: 2, durability: 1 } },
];

function deriveQualities(category: string, text: string): QualityScores {
  const base = { ...(CATEGORY_BASE[category] ?? FALLBACK_BASE) };

  for (const claim of CLAIMS) {
    if (!claim.pattern.test(text)) continue;
    for (const key of claim.introduces ?? []) {
      if (base[key] === undefined) base[key] = 3;
    }
    for (const [key, shift] of Object.entries(claim.shifts) as [QualityKey, number][]) {
      if (base[key] === undefined) continue; // never invent an unmeasured quality
      base[key] = base[key]! + shift;
    }
  }

  return Object.fromEntries(
    Object.entries(base).map(([k, v]) => [k, clamp(v as number)]),
  ) as QualityScores;
}

async function main() {
  const sqlClient = postgres(process.env.DATABASE_URL!, { max: 1 });
  const db = drizzle(sqlClient, { schema });

  const rows = await db
    .select({
      id: schema.products.id,
      title: schema.products.title,
      description: schema.products.description,
      category: schema.products.category,
      attributes: schema.products.attributes,
      searchTags: schema.products.searchTags,
    })
    .from(schema.products);

  let updated = 0;
  let alreadyHad = 0;

  for (const row of rows) {
    const attrs = (row.attributes ?? {}) as Record<string, unknown>;
    if (attrs.qualities) {
      alreadyHad++;
      continue;
    }

    const text = [row.title, row.description, ...(row.searchTags ?? []), JSON.stringify(attrs)].join(" ");
    const qualities = deriveQualities(row.category, text);

    await db
      .update(schema.products)
      .set({ attributes: { ...attrs, qualities }, updatedAt: new Date() })
      .where(eq(schema.products.id, row.id));
    updated++;
  }

  const [{ count: withQualities }] = await sqlClient<{ count: string }[]>`
    SELECT count(*) FROM products WHERE attributes ? 'qualities'`;

  console.log(`
backfilled ${updated} products (${alreadyHad} already had qualities)
products with qualities: ${withQualities} / ${rows.length}
`);
  await sqlClient.end();
}

main().catch((error) => { console.error(error); process.exit(1); });
