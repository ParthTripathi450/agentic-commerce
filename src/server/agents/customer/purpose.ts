/**
 * Does this product say it is FOR what the shopper asked for?
 *
 * Pure, no database, no model — the purpose text is already on the candidate.
 *
 * The gap this closes: "formal shoes for the office" put a pair of Court
 * Sneakers second, ahead of three actual dress shoes, on a score margin of
 * 0.010. Relevance could not separate them — a leather sneaker and a leather
 * dress shoe are genuinely close in both embedding and keyword space — but the
 * catalogue is not ambiguous at all. The dress shoe carries `use: "formal"` and
 * a feature called "interview"; the sneaker carries
 * `useCase: "everyday wear and casual court style"`. It declares itself casual.
 *
 * Three rules make this safe to score on, and the third is the one that matters:
 *
 * 1. It reads only fields a MERCHANT wrote, never an inferred category. §8.8 is
 *    about a guessed category becoming a hard filter; this ranks published text.
 * 2. It ranks, never filters. A product cannot be removed from consideration by
 *    it, only moved.
 * 3. **Silence is neutral, never negative.** A product with no purpose text at
 *    all scores exactly 0.5. Roughly a third of the catalogue publishes nothing
 *    here — the Windshell Packable Running Jacket has no `useCase`, `use` or
 *    `style` — and it is a correct answer for "a warm winter jacket". Penalising
 *    absence would demote every product whose merchant simply did not fill the
 *    field, which is a data-completeness bias dressed up as relevance.
 */

/** Fields a merchant uses to say what a product is for. */
const PURPOSE_FIELDS = ["useCase", "use", "style", "activity", "occasion", "fit"] as const;

/**
 * Words that carry no purpose information.
 *
 * Kept to genuine filler rather than a list of shopping words: §8.21's lesson is
 * that enumerating a domain fails for every member you did not think of, so
 * nothing here names a product type, an activity or a setting.
 */
const FILLER = new Set([
  "the", "and", "for", "with", "that", "this", "you", "your", "can", "could",
  "would", "some", "something", "anything", "want", "need", "looking", "look",
  "buy", "get", "give", "show", "find", "have", "has", "are", "was", "were",
  "but", "not", "any", "all", "from", "into", "out", "who", "what", "which",
  "when", "where", "how", "please", "thanks", "very", "just", "really", "wear",
]);

/** Absence of evidence. Never confused with evidence of a bad match. */
export const NEUTRAL_PURPOSE = 0.5;

function terms(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((t) => !FILLER.has(t)),
  );
}

/** Every purpose-bearing string a product publishes, flattened. */
export function purposeTextOf(attributes: Record<string, unknown> | null | undefined): string {
  if (!attributes) return "";

  const fields = PURPOSE_FIELDS.map((key) => attributes[key]).filter(
    (v): v is string => typeof v === "string",
  );

  const features = Array.isArray(attributes.features)
    ? (attributes.features as unknown[]).filter((f): f is string => typeof f === "string")
    : [];

  return [...fields, ...features].join(" ");
}

/**
 * 0..1, centred on 0.5 meaning "the catalogue does not say".
 *
 * Above 0.5 the product's own words overlap what was asked for; below it, the
 * product says what it is for and it is something else. Scored on the SHARE of
 * the query's meaningful words that the product's purpose text accounts for, so
 * a long marketing sentence cannot outscore a precise one by sheer length.
 */
export function purposeMatch(
  queryText: string,
  attributes: Record<string, unknown> | null | undefined,
): { normalized: number; matched: string[] } {
  const asked = terms(queryText);
  if (asked.size === 0) return { normalized: NEUTRAL_PURPOSE, matched: [] };

  /*
   * Features can EARN a match but never trigger the mismatch penalty.
   *
   * "interview" on a dress shoe genuinely answers "for the office", so features
   * are worth matching against. But "reflective trim" and "packs into pocket"
   * are not a statement of purpose, and treating their presence as one meant a
   * product that listed features and no purpose was scored as having declared
   * something else — which is precisely the Windshell Packable Running Jacket,
   * a correct answer for "a warm winter jacket". Only a real purpose field
   * counts as the merchant having spoken.
   */
  const stated = statedPurposeOf(attributes);
  const searchable = terms(purposeTextOf(attributes));
  const matched = [...asked].filter((t) => searchable.has(t));

  if (matched.length > 0) {
    const coverage = matched.length / asked.size;
    return { normalized: Math.min(1, NEUTRAL_PURPOSE + coverage), matched };
  }

  // Nothing matched. Only a product that actually declared a purpose is marked
  // down for it; silence stays neutral.
  return { normalized: stated ? 0.35 : NEUTRAL_PURPOSE, matched: [] };
}

/** True when the merchant stated what the product is for, features aside. */
function statedPurposeOf(attributes: Record<string, unknown> | null | undefined): boolean {
  if (!attributes) return false;
  return PURPOSE_FIELDS.some((key) => typeof attributes[key] === "string" && attributes[key]);
}
