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
  quantity: z.number().int().min(1).max(10).default(1),
  priority: z.enum(PRIORITIES).default("balanced"),
  currency: z.string().length(3).default("INR"),
  requireInStock: z.boolean().default(true),
  /** Set when the request is too vague to search on without guessing. */
  clarificationNeeded: z.string().max(300).nullable().default(null),
});

export type ShoppingIntent = z.infer<typeof shoppingIntentSchema>;
