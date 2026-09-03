/**
 * Turning what we know about a shopper into one number the ranker can use.
 *
 * Pure on purpose — no database, no model. The knowledge base is built in SQL
 * and handed here as plain data, so what the personal signal does to a ranking
 * is unit-testable and can be shown to the shopper in the same score breakdown
 * as price and rating. A preference that moves the results but cannot be
 * pointed at is indistinguishable from a bug.
 */

export type TasteProfile = {
  /** Normalised name -> strength in 0..1. Negative preferences live below. */
  brands: Record<string, number>;
  categories: Record<string, number>;
  merchants: Record<string, number>;
  qualities: Record<string, number>;
  colours: Record<string, number>;
  dislikedBrands: Record<string, number>;
  dislikedCategories: Record<string, number>;
  /** The middle half of what they actually pay, per item. */
  budget: { p25Minor: number; p75Minor: number } | null;
};

export const EMPTY_TASTE: TasteProfile = {
  brands: {},
  categories: {},
  merchants: {},
  qualities: {},
  colours: {},
  dislikedBrands: {},
  dislikedCategories: {},
  budget: null,
};

/**
 * How much of the score personal history may claim.
 *
 * Small on purpose. A shopper who has bought four pairs of running shoes should
 * see their usual brand break a tie, not see it beat a better-matching, better-
 * rated, cheaper product — that is how a recommender turns into a filter bubble
 * the shopper never asked for and cannot switch off. At 0.15 affinity reorders
 * near-equals and nothing else.
 */
export const AFFINITY_WEIGHT = 0.15;

const key = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export function hasTaste(profile: TasteProfile): boolean {
  return (
    Object.keys(profile.brands).length > 0 ||
    Object.keys(profile.categories).length > 0 ||
    Object.keys(profile.qualities).length > 0 ||
    Object.keys(profile.dislikedBrands).length > 0 ||
    profile.budget != null
  );
}

type AffinityInput = {
  brand?: string | null;
  category?: string | null;
  merchantName?: string | null;
  colour?: string | null;
  priceMinor: number;
  qualities?: Record<string, number> | null;
};

/**
 * How much each axis of the profile counts toward the personal score.
 *
 * Brand, category and quality ARE the preference; merchant, colour and budget
 * modify it. Left unweighted, budget swamped everything — almost every product
 * is inside a shopper's usual range, so a weighted mean over equal axes handed
 * a full score to anything affordable and the criterion stopped discriminating.
 */
const AXIS = {
  brand: 1,
  category: 0.8,
  quality: 1,
  merchant: 0.4,
  colour: 0.3,
  budget: 0.5,
} as const;

/**
 * The personal score for one product, in 0..1 with **0.5 meaning "we have no
 * idea"**.
 *
 * The neutral point is the important part. Scoring an unfamiliar product 0
 * would make this criterion a 15% penalty on everything new, and the agent
 * would quietly stop showing the shopper anything they had not already bought —
 * a filter bubble built out of a criterion that was only ever meant to break
 * ties. Absence of evidence has to land in the middle.
 *
 * Axes are averaged, never summed. A product matching on brand AND merchant AND
 * colour is usually three restatements of the same past purchase, and summing
 * would let that one purchase run away with the score.
 */
export function affinityFor(
  item: AffinityInput,
  profile: TasteProfile,
): { normalized: number; reasons: string[] } {
  const parts: { value: number; weight: number }[] = [];
  const reasons: string[] = [];
  const add = (value: number, weight: number) => parts.push({ value, weight });

  const brand = key(item.brand);
  if (brand) {
    const liked = profile.brands[brand];
    const disliked = profile.dislikedBrands[brand];
    if (liked) {
      add(liked, AXIS.brand);
      reasons.push(`you have bought ${item.brand} before`);
    } else if (disliked) {
      add(-disliked, AXIS.brand);
      reasons.push(`you rated ${item.brand} poorly`);
    }
  }

  const category = key(item.category);
  if (category) {
    const liked = profile.categories[category];
    const disliked = profile.dislikedCategories[category];
    if (liked) {
      add(liked, AXIS.category);
      reasons.push("matches what you usually shop for");
    } else if (disliked) add(-disliked, AXIS.category);
  }

  const merchant = key(item.merchantName);
  if (merchant && profile.merchants[merchant]) {
    add(profile.merchants[merchant], AXIS.merchant);
    reasons.push(`${item.merchantName} has served you well`);
  }

  const colour = key(item.colour);
  if (colour && profile.colours[colour]) {
    add(profile.colours[colour], AXIS.colour);
    reasons.push(`${item.colour} is a colour you go for`);
  }

  // Qualities are the most portable part of a profile: "likes breathable
  // things" carries into a category the shopper has never bought from, which is
  // the one case where a profile can help with a genuinely new request.
  const qualities = item.qualities ?? {};
  const matched: string[] = [];
  let qualityScore = 0;
  let qualityWeight = 0;
  for (const [name, strength] of Object.entries(profile.qualities)) {
    const rated = qualities[name];
    if (rated === undefined) continue;
    qualityWeight += strength;
    // Rescaled to -1..1 about the midpoint: a 1/5 on something they care about
    // counts against the product, not merely less for it.
    qualityScore += strength * ((rated - 3) / 2);
    if (rated >= 4) matched.push(humanise(name));
  }
  if (qualityWeight > 0) {
    add(qualityScore / qualityWeight, AXIS.quality);
    if (matched.length > 0) reasons.push(`strong on ${matched.slice(0, 2).join(" and ")}`);
  }

  if (profile.budget) add(budgetFit(item.priceMinor, profile.budget), AXIS.budget);

  if (parts.length === 0) return { normalized: 0.5, reasons: [] };

  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  const mean = parts.reduce((sum, p) => sum + p.value * p.weight, 0) / totalWeight;
  return { normalized: clamp((mean + 1) / 2), reasons: reasons.slice(0, 2) };
}

/**
 * Mildly positive inside the shopper's usual range, negative well above it.
 *
 * Deliberately gentle, and never negative BELOW the range: something cheaper
 * than they usually pay is not a worse match, it is a bargain. Only the
 * expensive side is penalised, and it takes roughly double their usual top
 * price to bottom out — people do buy the occasional expensive thing, and a
 * profile that made that impossible would be wrong about everyone eventually.
 */
function budgetFit(priceMinor: number, budget: { p25Minor: number; p75Minor: number }): number {
  if (priceMinor <= budget.p75Minor) return priceMinor >= budget.p25Minor ? 0.5 : 0.3;
  const over = (priceMinor - budget.p75Minor) / Math.max(budget.p75Minor, 1);
  return clamp(0.5 - over, -1, 1);
}

function clamp(n: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, n));
}

function humanise(name: string): string {
  return name.replace(/([A-Z])/g, " $1").toLowerCase().trim();
}
