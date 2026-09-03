import { z } from "zod";
import { normalizeTypography } from "@/lib/text";
import {
  evidenceByTopic,
  retrieveEvidence,
  type EvidenceChunk,
} from "@/server/catalog/evidence";
import { formatMoney } from "@/lib/money";
import { completeJson } from "@/server/ai/llm";
import { getProductDetail, type ProductDetail, type ProductVariantView } from "@/server/catalog/product-page";

/**
 * Conversation scoped to ONE product.
 *
 * The catalogue-wide agent answers "what should I buy?". Once a shopper has
 * decided, their next questions are narrower — "in navy instead", "do you have
 * an 11?", "what's the cheapest size?" — and answering those with a fresh
 * catalogue search is wrong twice over: it can wander off to a different
 * product, and it throws away the fact that they already chose this one.
 *
 * So the model reads the request and code resolves it against THIS product's
 * real variants. It can only ever land on something that exists, and when the
 * asked-for combination does not exist it says so and names what does — rather
 * than quietly returning the nearest thing.
 */

const changeSchema = z.object({
  /** Colour they asked for, exactly as they said it. */
  color: z.string().max(40).nullable().default(null),
  size: z.string().max(20).nullable().default(null),
  /** True when they want the cheapest option rather than a specific variant. */
  wantsCheapest: z.boolean().default(false),
  /** A question about the product rather than a request to change variant. */
  question: z.string().max(200).nullable().default(null),
});

export type RefineResult = {
  /** The variant the request resolves to, or the current one if nothing changed. */
  variant: ProductVariantView | null;
  /** Plain sentence describing what happened, shown to the shopper. */
  reply: string;
  /** Options that exist, so a refusal always comes with an alternative. */
  availableColors: string[];
  availableSizes: string[];
  /**
   * Real review sentences backing the reply, when the shopper asked something
   * the reviews can answer. Quoted verbatim so the claim is traceable to a
   * person who wrote it, never paraphrased into the reply and lost.
   */
  evidence: EvidenceChunk[];
  degraded: boolean;
};

const SYSTEM = `A customer is looking at one specific product and wants to adjust it or ask about it.

Extract only what they asked for:
- color: a colour they want instead, or null
- size: a size they want, or null
- wantsCheapest: true only if they asked for the cheapest or a lower price
- question: if they asked something about the product rather than requesting a change, put their question here, else null

Report the colour or size they ASKED FOR even when it is not in the available list — saying "we do not have purple" is the useful answer, and that is impossible if you drop the word. Only leave them null when the customer did not mention one.

Never invent a colour or size they did not mention. Reply with JSON only:
{"color":string|null,"size":string|null,"wantsCheapest":boolean,"question":string|null}`;

/** Colour words worth recognising even when nothing in the catalogue is one. */
const COMMON_COLOURS = [
  "black", "white", "navy", "blue", "red", "green", "grey", "gray", "brown",
  "beige", "cream", "purple", "pink", "orange", "yellow", "olive", "tan",
  "burgundy", "maroon", "teal", "charcoal", "sage", "rust", "gold", "silver",
];

/** Rule fallback: match their words against the options this product has. */
function extractWithRules(
  message: string,
  product: ProductDetail,
): z.infer<typeof changeSchema> {
  const text = message.toLowerCase();
  const colors = distinct(product, "color");
  const sizes = distinct(product, "size");

  const color =
    colors.find((c) => new RegExp(`\\b${escape(c)}\\b`, "i").test(text)) ??
    // Colours we do NOT stock still have to be recognised, or the shopper is
    // told nothing rather than "we don't have purple".
    COMMON_COLOURS.find((c) => new RegExp(`\\b${c}\\b`, "i").test(text)) ??
    null;
  const size =
    sizes.find((s) => new RegExp(`\\b(?:size\\s*)?${escape(s)}\\b`, "i").test(text)) ??
    text.match(/\bsize\s+([a-z0-9]{1,4})\b/i)?.[1] ??
    null;

  return {
    color,
    size,
    wantsCheapest: /\b(cheap|cheaper|cheapest|less|lower price|budget)\b/.test(text),
    question: color || size ? null : message.slice(0, 200),
  };
}

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function distinct(product: ProductDetail, key: string): string[] {
  return [...new Set(product.variants.map((v) => v.attributes[key]).filter(Boolean))];
}

/**
 * Picks the variant that best satisfies the request.
 *
 * Keeps whatever the shopper did NOT ask to change: asking for navy should not
 * silently move them to a different size.
 */
export function resolveVariant(
  product: ProductDetail,
  current: ProductVariantView | undefined,
  want: { color: string | null; size: string | null; wantsCheapest: boolean },
): { variant: ProductVariantView | null; missing: string | null } {
  const color = want.color ?? current?.attributes.color ?? null;
  const size = want.size ?? current?.attributes.size ?? null;

  const matches = product.variants.filter(
    (v) =>
      (!color || (v.attributes.color ?? "").toLowerCase() === color.toLowerCase()) &&
      (!size || (v.attributes.size ?? "").toLowerCase() === size.toLowerCase()),
  );

  const inStock = matches.filter((v) => v.availableQuantity > 0);
  const pool = inStock.length > 0 ? inStock : matches;

  if (pool.length === 0) {
    // Say which half of the request could not be met, not just "no".
    const colorExists =
      !want.color ||
      product.variants.some((v) => (v.attributes.color ?? "").toLowerCase() === want.color!.toLowerCase());
    const sizeExists =
      !want.size ||
      product.variants.some((v) => (v.attributes.size ?? "").toLowerCase() === want.size!.toLowerCase());

    const missing = !colorExists
      ? `colour ${want.color}`
      : !sizeExists
        ? `size ${want.size}`
        : `${want.color ?? color} in size ${want.size ?? size}`;
    return { variant: null, missing };
  }

  const sorted = want.wantsCheapest
    ? [...pool].sort((a, b) => a.priceMinor - b.priceMinor)
    : pool;

  return { variant: sorted[0], missing: null };
}

export async function refineProduct(input: {
  productId: string;
  message: string;
  currentVariantId?: string | null;
}): Promise<RefineResult | null> {
  const product = await getProductDetail(input.productId);
  if (!product) return null;

  const current = product.variants.find((v) => v.variantId === input.currentVariantId);
  const availableColors = distinct(product, "color");
  const availableSizes = distinct(product, "size");

  let want = extractWithRules(input.message, product);
  let degraded = true;

  try {
    const { value, meta } = await completeJson(
      {
        task: "parse_intent",
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content:
              `Product: ${product.title} (${product.category}).\n` +
              `Colours: ${availableColors.join(", ") || "none"}.\n` +
              `Sizes: ${availableSizes.join(", ") || "none"}.\n\n` +
              input.message,
          },
        ],
        temperature: 0.1,
        maxTokens: 1300,
        reasoningEffort: "low",
        fallback: () => JSON.stringify(want),
      },
      (raw) => changeSchema.parse(raw),
    );
    want = value;
    degraded = meta.degraded;
  } catch {
    // Rules already produced a usable answer; keep it (§8.13).
  }

  const { variant, missing } = resolveVariant(product, current, want);

  if (missing) {
    return {
      variant: current ?? null,
      reply:
        `Sorry — no ${missing} on this one. ` +
        (availableColors.length ? `Colours: ${availableColors.join(", ")}. ` : "") +
        (availableSizes.length ? `Sizes: ${availableSizes.join(", ")}.` : ""),
      availableColors,
      availableSizes,
      evidence: [],
      degraded,
    };
  }

  if (!variant) {
    return {
      variant: current ?? null,
      reply: "I could not find a matching option for that.",
      availableColors,
      availableSizes,
      evidence: [],
      degraded,
    };
  }

  const parts: string[] = [];
  if (want.color) parts.push(`in ${want.color}`);
  if (want.size) parts.push(`size ${want.size}`);
  if (want.wantsCheapest) parts.push("cheapest available");

  const described = Object.values(variant.attributes).join(" · ");
  const stock =
    variant.availableQuantity > 0
      ? `${variant.availableQuantity} in stock`
      : "currently out of stock";

  const answered =
    parts.length === 0 && want.question
      ? await answerFromProduct(product, variant, want.question)
      : null;

  const reply = parts.length
    ? `Here it is ${parts.join(", ")} — ${described} at ${formatMoney(variant.priceMinor, variant.currency)}, ${stock}.`
    : (answered?.reply ??
       `Showing ${described} at ${formatMoney(variant.priceMinor, variant.currency)}, ${stock}.`);

  return {
    variant,
    reply: normalizeTypography(reply),
    availableColors,
    availableSizes,
    evidence: answered?.evidence ?? [],
    degraded,
  };
}

/**
 * Answers a question from the product's own published facts, and from what its
 * buyers actually wrote.
 *
 * Deliberately not a free-form model answer: this is the one place a shopper is
 * most likely to be told something the catalogue never claimed. The score is
 * the summary and the quoted review is the evidence for it — "rates 4/5 for
 * breathability" is a number nobody can act on, while "no swampy feeling even
 * on long days" is the answer to the question they actually asked.
 *
 * Retrieval, not generation: the sentence is returned verbatim with its
 * reviewer's rating. Nothing is summarised, so there is nothing to get wrong,
 * and when no review is close enough the reply simply stays with the facts
 * rather than reaching for the nearest thing.
 */
async function answerFromProduct(
  product: ProductDetail,
  variant: ProductVariantView,
  question: string,
): Promise<{ reply: string; evidence: EvidenceChunk[] }> {
  const qualities = (product.attributes as { qualities?: Record<string, number> }).qualities ?? {};
  /*
   * Matches a shared PREFIX in either direction.
   *
   * "is it breathable?" must reach `breathability`, and neither exact matching
   * nor suffix-stripping gets there — dropping "ity" leaves "breathabil",
   * which is not in "breathable" either. Comparing prefixes handles that pair
   * and durable/durability and warm/warmth, without a table of word forms.
   */
  const words = question.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const asked = Object.keys(qualities).find((key) => {
    const head = key
      .replace(/([A-Z])/g, " $1")
      .trim()
      .split(" ")[0]
      .toLowerCase();
    const stem = head.slice(0, 5);
    return words.some((word) => word.startsWith(stem) || head.startsWith(word.slice(0, 5)));
  });

  /*
   * When the question names a quality, the quote MUST be about that quality.
   *
   * Nearest-chunk retrieval is not enough here. Scoped to one product every
   * review is written in the same register about the same object, so they all
   * score similarly against any question and the nearest one is often about
   * something else — "how is the grip on wet ground?" was answered with "nails
   * the comfort, wore them for twelve hours". An off-topic citation is worse
   * than none: it looks like evidence, so it is believed, and it is not.
   *
   * `evidenceByTopic` assigns each chunk to the ONE topic it is most about, so
   * asking it for this quality's bucket returns only sentences that are more
   * about this than about anything else the product is rated on — or nothing.
   */
  if (asked) {
    const label = asked.replace(/([A-Z])/g, " $1").toLowerCase().trim();
    const summary = `${product.title} rates ${qualities[asked]}/5 for ${label}.`;

    const byTopic = await evidenceByTopic(product.productId, Object.keys(qualities), 1)
      .catch(() => [] as { topic: string; chunks: EvidenceChunk[] }[]);
    const onTopic = byTopic.find((t) => t.topic === asked)?.chunks ?? [];

    const quoted = onTopic[0]
      ? ` A buyer wrote: "${onTopic[0].body}"`
      : ` No review says much about that. It is ${formatMoney(variant.priceMinor, variant.currency)} in ${Object.values(variant.attributes).join(" · ")}.`;
    return { reply: summary + quoted, evidence: onTopic };
  }

  // No quality named — an open question ("is the cushioning any good?"). Here
  // the shopper's own words ARE the best query: reviews are prose, and free
  // text retrieves against prose better than a column name would.
  const evidence = await retrieveEvidence({
    question,
    productIds: [product.productId],
    limit: 2,
  }).catch(() => [] as EvidenceChunk[]);

  if (evidence[0]) {
    return {
      reply: `Nothing in the spec covers that, but a buyer wrote: "${evidence[0].body}"`,
      evidence,
    };
  }

  return {
    reply:
      `${product.title} — ${formatMoney(variant.priceMinor, variant.currency)}, ` +
      `${variant.availableQuantity > 0 ? `${variant.availableQuantity} in stock` : "out of stock"}. ` +
      `${product.merchant.returnsAccepted ? `${product.merchant.returnWindowDays}-day returns` : "No returns"} ` +
      `from ${product.merchant.name}.`,
    evidence: [],
  };
}
