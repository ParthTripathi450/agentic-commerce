import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });

/**
 * Re-measures the relevance gate against the CURRENT catalogue.
 *
 * `MIN_TOP_RELEVANCE` is a measured number, not a taste call: it has to sit
 * above what unstocked queries score and below what stocked ones do. Both bands
 * move when the catalogue changes — growing it from 184 to 503 products lifted
 * the unstocked ceiling from 0.307 to 0.375, because a marketplace that now
 * sells kitchen appliances IS genuinely nearer to "washing machine".
 *
 * Run this after any material catalogue change, and move the threshold to the
 * midpoint of the measured gap. Never lower it to make a query pass.
 */

const UNSTOCKED = [
  "electric guitar", "diamond engagement ring", "washing machine", "gaming laptop",
  "car tyres", "prescription medication", "garden shed", "violin bow",
  "motorcycle helmet", "office desk chair", "smartphone", "dishwasher tablets",
];
const STOCKED = [
  "road running shoes", "waterproof rain jacket", "cotton t-shirt", "chef knife",
  "wireless earbuds", "yoga mat", "bath towels", "hiking boots",
  "vacuum flask", "duvet cover", "portable speaker", "daypack",
];

async function main() {
  const { hybridSearch } = await import("@/server/catalog/search");
  const score = async (q: string) => {
    const r = await hybridSearch({ text: q, requireInStock: true, limit: 5 });
    return { q, top: r.stats.topRelevance, n: r.candidates.length, flag: r.noRelevantMatch };
  };

  const un = await Promise.all(UNSTOCKED.map(score));
  const st = await Promise.all(STOCKED.map(score));

  un.sort((a, b) => b.top - a.top);
  st.sort((a, b) => a.top - b.top);

  console.log("UNSTOCKED (highest first — the ceiling we must sit above):");
  for (const r of un) console.log(`  ${r.top.toFixed(3)}  ${r.q}`);
  console.log("\nSTOCKED (lowest first — the floor we must sit below):");
  for (const r of st) console.log(`  ${r.top.toFixed(3)}  ${r.q}`);

  const ceiling = Math.max(...un.map((r) => r.top));
  const floor = Math.min(...st.map((r) => r.top));
  console.log(`\nunstocked ceiling: ${ceiling.toFixed(3)}`);
  console.log(`stocked floor    : ${floor.toFixed(3)}`);
  console.log(`gap              : ${(floor - ceiling).toFixed(3)}`);
  console.log(`midpoint         : ${((floor + ceiling) / 2).toFixed(3)}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
