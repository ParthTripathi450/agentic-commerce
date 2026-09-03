import { QUALITY_LABELS, type QualityKey, type QualityScores } from "./catalog-blueprints";

/**
 * Writes reviews FROM a product's quality scores.
 *
 * This is the part that makes the corpus worth retrieving over. A review that
 * praises breathability on a shoe scored 1/5 for it is noise — worse than
 * absent, because it teaches the retriever a false association. So every
 * sentence here is selected by a score, and the star rating is derived from the
 * same scores, which means opinion, prose and attributes all agree.
 *
 * Diversity of PHRASING with consistency of CONTENT is the goal: retrieval
 * needs many ways of saying "it breathes well" to match against, but never a
 * claim the data does not support.
 */

export type ReviewDraft = {
  ratingBp: number;
  title: string;
  body: string;
  /** Which qualities this review actually talks about — used by the eval set. */
  mentions: QualityKey[];
};

/** Things a happy reviewer says about a quality that scored 4–5. */
const PRAISE: Partial<Record<QualityKey, string[]>> = {
  breathability: [
    "my feet stayed cool through a July afternoon",
    "plenty of airflow — no swampy feeling even on long days",
    "breathes far better than the pair it replaced",
  ],
  waterResistance: [
    "walked through wet grass for an hour and stayed completely dry",
    "rain just beads off it",
    "got caught in a downpour and nothing came through",
  ],
  grip: [
    "grip on wet rock is genuinely confidence-inspiring",
    "no slipping at all, even on polished floors",
    "holds on loose gravel where my old ones skated",
  ],
  comfort: [
    "comfortable straight out of the box, no break-in",
    "wore them for twelve hours and forgot they were on",
    "the cushioning is spot on — soft without feeling vague",
  ],
  durability: [
    "six months in and it still looks nearly new",
    "the stitching has not budged",
    "takes a real beating and shrugs it off",
  ],
  warmth: [
    "toasty at well below freezing",
    "warmer than its weight suggests",
    "did not need a second layer all winter",
  ],
  materialQuality: [
    "you can feel the quality the moment you pick it up",
    "the materials are a clear step above the price",
    "beautifully finished — no loose threads anywhere",
  ],
  support: [
    "my knees have stopped complaining after long days",
    "holds the arch properly without feeling rigid",
    "the ankle support makes a real difference on uneven ground",
  ],
  packability: [
    "squashes down to nothing in a bag",
    "packs smaller than my water bottle",
    "barely takes up any room in a carry-on",
  ],
  easeOfCare: [
    "straight in the machine and out looking fine",
    "wipes clean in seconds",
    "no special care needed, which I appreciate",
  ],
  batteryLife: [
    "a full week of commuting on one charge",
    "the battery genuinely lasts as long as they claim",
    "I have stopped carrying a charger",
  ],
  soundQuality: [
    "the detail in the mid-range surprised me",
    "bass is present without drowning everything",
    "sounds far better than anything near this price",
  ],
  noiseIsolation: [
    "cut out the engine drone on a long flight completely",
    "office chatter disappears",
    "the isolation is the best part",
  ],
  portability: [
    "light enough that I forget it is in the bag",
    "genuinely pocketable",
    "goes everywhere with me",
  ],
  heatRetention: [
    "still steaming six hours later",
    "coffee was hot at lunch after filling it at seven",
    "keeps ice overnight without a problem",
  ],
  sharpness: [
    "sliced a tomato without any pressure at all",
    "sharp out of the box and staying that way",
    "holds an edge much longer than my last one",
  ],
  nonStick: [
    "eggs slide straight off",
    "nothing has stuck yet, even without oil",
    "the coating still works perfectly",
  ],
  absorbency: [
    "dries you properly rather than pushing water around",
    "soaks up far more than its size suggests",
  ],
  softness: [
    "softer after every wash rather than rougher",
    "genuinely lovely against the skin",
  ],
  brightness: [
    "lights the whole trail, not just a spot",
    "brighter than I expected from something this small",
  ],
  stability: [
    "rock solid under a heavy squat",
    "no wobble at all through lateral moves",
  ],
  capacity: [
    "swallowed a week of kit without straining",
    "far more goes in than you would guess",
  ],
};

/** Things a fair reviewer says about a quality that scored 1–2. */
const GRIPE: Partial<Record<QualityKey, string[]>> = {
  breathability: [
    "my feet cooked on anything above 25 degrees",
    "not much airflow — fine in winter, sweaty in summer",
    "it does trap heat, which was not a surprise given the material",
  ],
  waterResistance: [
    "a puddle goes straight through, so not one for wet days",
    "soaks immediately in rain",
    "no water resistance to speak of — worth knowing before you buy",
  ],
  grip: [
    "slid a bit on wet tile",
    "the sole is smoother than I would like",
  ],
  comfort: [
    "needed a solid week of breaking in",
    "the footbed is firmer than I expected",
  ],
  durability: [
    "starting to show wear after a couple of months",
    "the finish scuffs easily",
  ],
  warmth: [
    "not warm on its own — you will want a layer under it",
    "fine in autumn, nowhere near enough in January",
  ],
  materialQuality: [
    "the materials feel exactly like the price",
    "a couple of loose threads out of the box",
  ],
  packability: [
    "bulky in a bag — no way to compress it",
    "takes up more room than I hoped",
  ],
  easeOfCare: [
    "hand wash only, which is a faff",
    "marks easily and takes effort to clean",
  ],
  batteryLife: [
    "battery is fine for a day but not much more",
    "I charge it more often than I would like",
  ],
  noiseIsolation: [
    "you still hear most of what is around you",
  ],
  portability: [
    "heavier than it looks — not one for a small bag",
  ],
  heatRetention: [
    "warm rather than hot after a couple of hours",
  ],
  nonStick: [
    "needs a decent amount of oil or things catch",
  ],
  support: [
    "not much structure — fine for short walks only",
  ],
};

const OPENERS_POSITIVE = [
  "Exactly what I wanted.", "Really pleased with this.", "Bought on a whim, no regrets.",
  "Second pair — the first lasted years.", "Does the job properly.", "Genuinely impressed.",
  "Better than I expected for the money.",
];
const OPENERS_MIXED = [
  "Good, with one caveat.", "Mostly happy.", "Solid, but know what you are getting.",
  "Does most things well.", "Fine for the price.",
];
const OPENERS_NEGATIVE = [
  "Wanted to like this more.", "Not quite right for me.", "Mixed feelings.",
  "It is fine, but I expected more.",
];

const CLOSERS_POSITIVE = [
  "Would buy again.", "No hesitation recommending it.", "Happy with the purchase.",
  "Worth the money.",
];
const CLOSERS_MIXED = [
  "Worth it if that trade-off suits you.", "Just go in knowing that.",
  "Still glad I bought it.",
];
const CLOSERS_NEGATIVE = [
  "Might try something else next time.", "Returned in the end.",
  "Not bad, just not for me.",
];

/**
 * Star rating derived from the scores, not drawn independently.
 *
 * Real ratings skew high, so this maps a 1–5 quality mean onto roughly
 * 3.2–4.9 and lets `variance` move an individual reviewer either way. A product
 * that is genuinely mediocre still collects the occasional 5, and a good one
 * the occasional 3 — without that, ratings would be a perfect proxy for the
 * scores and carry no independent signal.
 */
export function ratingFromQualities(qualities: QualityScores, variance: number): number {
  const values = Object.values(qualities).filter((v): v is number => typeof v === "number");
  if (values.length === 0) return 4200;

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const centred = 3.2 + (mean - 2.5) * 0.68;
  const stars = Math.max(1, Math.min(5, centred + variance));
  return Math.round(stars * 1000);
}

function pickFrom<T>(arr: T[], rand: () => number): T {
  return arr[Math.floor(rand() * arr.length)];
}

/**
 * Composes one review.
 *
 * `rand` is passed in so the whole corpus is reproducible from a single seed —
 * an eval set built against these reviews stays valid across re-runs.
 */
export function writeReview(input: {
  productTitle: string;
  category: string;
  qualities: QualityScores;
  rand: () => number;
}): ReviewDraft {
  const { qualities, rand } = input;

  const scored = Object.entries(qualities) as [QualityKey, number][];
  const strong = scored.filter(([, v]) => v >= 4).sort((a, b) => b[1] - a[1]);
  const weak = scored.filter(([, v]) => v <= 2).sort((a, b) => a[1] - b[1]);

  // Individual reviewers disagree; this is what stops rating being a pure
  // function of the scores.
  const variance = (rand() - 0.5) * 1.6;
  const ratingBp = ratingFromQualities(qualities, variance);
  const stars = ratingBp / 1000;

  const mentions: QualityKey[] = [];
  const sentences: string[] = [];

  // Praise up to two genuine strengths.
  for (const [key] of strong.slice(0, 2)) {
    const bank = PRAISE[key];
    if (!bank) continue;
    sentences.push(pickFrom(bank, rand));
    mentions.push(key);
  }

  // Name a real weakness. Even a five-star review mentions one sometimes —
  // that honesty is what makes the corpus useful for "is X breathable?".
  const shouldGripe = weak.length > 0 && (stars < 4.3 || rand() < 0.45);
  if (shouldGripe) {
    const [key] = weak[0];
    const bank = GRIPE[key];
    if (bank) {
      sentences.push(pickFrom(bank, rand));
      mentions.push(key);
    }
  }

  // A review with nothing specific to say is filler; fall back to the category.
  if (sentences.length === 0) {
    sentences.push(`Does what it should for ${input.category.toLowerCase()}.`);
  }

  const opener =
    stars >= 4.3 ? pickFrom(OPENERS_POSITIVE, rand)
    : stars >= 3.4 ? pickFrom(OPENERS_MIXED, rand)
    : pickFrom(OPENERS_NEGATIVE, rand);

  const closer =
    stars >= 4.3 ? pickFrom(CLOSERS_POSITIVE, rand)
    : stars >= 3.4 ? pickFrom(CLOSERS_MIXED, rand)
    : pickFrom(CLOSERS_NEGATIVE, rand);

  const body = [opener, capitaliseFirst(sentences.join(". ") + "."), closer].join(" ");

  /*
   * The headline names a quality, so its sentiment must come from THAT
   * quality's score — not from the overall stars.
   *
   * Using the stars produced corpus-poisoning contradictions: a shoe scoring
   * breathability 4 but durability 1 rates ~2.5 overall, so it was titled
   * "Breathability is the weak spot" above a body correctly praising the
   * airflow. The dataset's whole value is that prose, attributes and opinion
   * agree (§6); a review arguing with itself is worse than no review, because
   * retrieval learns the false association and nothing downstream can see it.
   */
  const headline = mentions.length
    ? titleFor(mentions[0], qualities[mentions[0]] ?? 3, rand)
    : stars >= 4 ? "Does the job" : "Fine, not remarkable";

  return { ratingBp, title: headline, body, mentions };
}

/**
 * A headline about one quality, agreeing with what the body says about it.
 *
 * `qualityScore` is that quality's own 1-5 rating, deliberately NOT the
 * reviewer's overall star rating — see the note at the call site.
 */
function titleFor(key: QualityKey, qualityScore: number, rand: () => number): string {
  const label = QUALITY_LABELS[key];
  const good = [`Great ${label}`, `The ${label} is the selling point`, `Nails the ${label}`];
  const bad = [`Let down by the ${label}`, `Watch the ${label}`, `${capitaliseFirst(label)} is the weak spot`];
  return qualityScore >= 4 ? pickFrom(good, rand) : pickFrom(bad, rand);
}

function capitaliseFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
