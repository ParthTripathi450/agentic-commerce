import { z } from "zod";

export const PRIORITIES = [
  "balanced",
  "cheapest",
  "fastest",
  "best_quality",
  "most_flexible",
] as const;

/**
 * The structured intent the UNDERSTAND step produces.
 *
 * Everything downstream — retrieval filters, ranking weights, the AP2 Intent
 * Mandate — is derived from this object, so it is validated strictly rather
 * than trusted as free-form model output.
 */
export const shoppingIntentSchema = z.object({
  productQuery: z.string().min(1).max(400),
  category: z.string().max(120).nullable().default(null),
  brand: z.string().max(120).nullable().default(null),
  attributes: z.record(z.string(), z.string()).default({}),
  priceMaxMinor: z.number().int().positive().nullable().default(null),
  priceMinMinor: z.number().int().positive().nullable().default(null),
  /**
   * Accepts 0, meaning "the shopper did not say".
   *
   * The model correctly returns 0 for "a few yoga mats" rather than inventing a
   * number — rejecting that as invalid input would punish exactly the behaviour
   * we asked for. Normalised to 1 after parsing, with quantityStated left false.
   */
  quantity: z.number().int().min(0).max(10).default(1),
  /**
   * Whether the shopper actually stated a number.
   *
   * Distinguishes "one, because they asked for a yoga mat" from "one, because
   * we guessed" — the second is a hallucination when they said "a few".
   */
  quantityStated: z.boolean().default(false),
  priority: z.enum(PRIORITIES).default("balanced"),
  currency: z.string().length(3).default("INR"),
  requireInStock: z.boolean().default(true),
  /**
   * Rated-feature constraints the shopper stated, carried through to retrieval
   * as a predicate rather than as similarity.
   */
  qualityConstraints: z
    .array(
      z.object({
        key: z.string().max(40),
        op: z.enum(["gte", "lte"]),
        value: z.number().int().min(1).max(5),
      }),
    )
    .max(4)
    .default([]),
  /** Set when the request is too vague to search on without guessing. */
  clarificationNeeded: z.string().max(300).nullable().default(null),
});

export type ShoppingIntent = z.infer<typeof shoppingIntentSchema>;
