import { z } from "zod";
import { normalizeTypography } from "@/lib/text";
import {
  evidenceByTopic,
  retrieveEvidence,
  reviewSample,
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

/**
 * Words that follow "in" without being a colour.
 *
 * Filler only. The list of COLOURS is the thing that must not be enumerated —
 * §8.21 — because it fails for every shade nobody thought of; a shopper asking
 * for chartreuse deserves "we do not have chartreuse", not silence.
 */
const NOT_A_COLOUR = new Set([
  "stock", "store", "size", "sizes", "the", "and", "any", "all", "this", "that",
  "your", "our", "their", "it", "them", "one", "two", "large", "small", "medium",
  "wide", "narrow", "leather", "suede", "mesh", "cotton", "wool", "total",
]);

/**
 * A colour recognised by the SHAPE of the sentence rather than by name.
 *
 * "do you have it in chartreuse", "is it available in volt colour". Catches
 * shades the hardcoded list never will, which is the whole point: the refusal
 * "we do not stock that" is only possible if the word survives extraction.
 */
function colourByShape(text: string): string | null {
  const patterns = [
    /\b([a-z]{3,15})\s+colou?r\b/i,
    /\bcolou?r\s+([a-z]{3,15})\b/i,
    /\b(?:in|into)\s+([a-z]{3,15})\b/i,
  ];

  for (const pattern of patterns) {
    const found = pattern.exec(text)?.[1]?.toLowerCase();
    if (found && !NOT_A_COLOUR.has(found)) return found;
  }
  return null;
}

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
    colourByShape(text) ??
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

  const byRules = extractWithRules(input.message, product);
  let want = byRules;
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

  /*
   * The rules are a SAFETY NET over the model, not merely a replacement for it.
   *
   * `want = value` used to discard the rule extraction wholesale, so a model
   * that answered confidently but wrongly took the whole turn with it. That is
   * what "is it available in volt colour" hit: the model returned
   * `color: null`, the rules' correct reading of "volt" was thrown away, and
   * the question fell through to a catch-all that recited price and stock —
   * with nothing degraded and no error anywhere to show for it.
   *
   * Only NULLS are backfilled. A colour the model actually stated wins, because
   * it read the sentence in context and can tell "not black, something else"
   * from "black"; but silence from the model is not evidence that the shopper
   * said nothing. Same shape as §8.8, where safety-relevant fields are
   * rule-owned rather than left to whatever the model felt like returning.
   */
  want = {
    ...want,
    color: want.color ?? byRules.color,
    size: want.size ?? byRules.size,
  };

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
  /*
   * "What colours does it come in?" is the commonest question on a product
   * page, and it was falling through to the catch-all: the reply recited price
   * and stock while `availableColors` sat right there, computed and unused.
   *
   * The axes are read off the product's OWN variants rather than a list of
   * things shoppers might ask about, so a catalogue that starts selling by
   * width or length answers those too without a code change. That is the §8.21
   * rule — a rule about the shape of the question, not an enumeration of the
   * domain.
   */
  const options = answerAboutOptions(product, question);
  if (options) return { reply: options, evidence: [] };

  // Terms are the other question the catch-all was answering only by accident:
  // it happened to mention returns while leading with price and stock.
  const policy = answerAboutPolicy(product, question);
  if (policy) return { reply: policy, evidence: [] };

  /*
   * "What are some of the reviews?" is a question about the CONTAINER, and
   * semantic retrieval cannot serve it: reviews talk about shoes, not about
   * reviews, so it scores 0.311 against its own corpus where "is it
   * comfortable" scores 0.553. The floor rejected it correctly and nine real
   * reviews stayed unreachable. Asking for a sample needs a sample, not a
   * search.
   */
  const reviews = await answerAboutReviews(product, question);
  if (reviews) return reviews;

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
      `from ${product.merchant.name.replace(/\.$/, "")}.`,
    evidence: [],
  };
}

/** Words in the question, long enough to be meaningful. */
function wordsOf(question: string): string[] {
  return question.toLowerCase().match(/[a-z]{3,}/g) ?? [];
}

/**
 * A shared four-character prefix, in either direction.
 *
 * The same trick the quality matcher uses, one character shorter because that
 * is what "colour" and "color" need: they agree on "colo" and diverge at the
 * fifth. It also carries plurals free — "sizes" reaches "size", "colours"
 * reaches "color".
 */
function looselyMatches(word: string, target: string): boolean {
  const a = word.slice(0, 4);
  const b = target.slice(0, 4);
  return a.length >= 3 && a === b;
}

/**
 * Answers "what colours / sizes does it come in?" from the live variant axes.
 *
 * Only values that genuinely exist and are in stock, because this is a promise:
 * naming a colour here means the shopper can go and buy it.
 */
function answerAboutOptions(product: ProductDetail, question: string): string | null {
  const words = wordsOf(question);

  const axes = new Map<string, Set<string>>();
  for (const variant of product.variants) {
    if (variant.availableQuantity <= 0) continue;
    for (const [axis, value] of Object.entries(variant.attributes)) {
      if (!value) continue;
      (axes.get(axis) ?? axes.set(axis, new Set()).get(axis)!).add(value);
    }
  }

  const asked = [...axes.keys()].find((axis) =>
    words.some((word) => looselyMatches(word, axis.toLowerCase())),
  );
  if (!asked) return null;

  const values = [...(axes.get(asked) ?? [])];
  if (values.length === 0) return null;

  const label = asked.toLowerCase() === "color" ? "colours" : `${asked.toLowerCase()}s`;
  return `${product.title} comes in ${values.length} ${label}: ${values.join(", ")}. All in stock.`;
}

/**
 * Answers a question about the terms rather than the product.
 *
 * Matched against the policy fields the merchant actually publishes, so this
 * says what is true of THIS merchant rather than a general statement about
 * returns — which is the only version worth showing beside a Buy button.
 */
function answerAboutPolicy(product: ProductDetail, question: string): string | null {
  const words = wordsOf(question);
  const { merchant } = product;

  const mentions = (...targets: string[]) =>
    words.some((word) => targets.some((t) => looselyMatches(word, t)));

  if (mentions("return", "refund", "exchange")) {
    return merchant.returnsAccepted
      ? `${merchant.name} accepts returns within ${merchant.returnWindowDays} days of delivery.`
      : `${merchant.name} does not accept returns on this item.`;
  }

  if (mentions("deliver", "shipping", "arrive", "dispatch", "posted")) {
    return `${merchant.name} usually delivers in about ${merchant.standardDeliveryDays} days.`;
  }

  return null;
}

/**
 * A sample of the reviews, when the shopper asked for reviews rather than for
 * an answer that reviews happen to contain.
 *
 * The shape of the request is what identifies it — a question naming the
 * container ("reviews", "ratings", "what people say") rather than any product
 * quality. Matched loosely so "review", "reviews" and "reviewed" all land.
 */
async function answerAboutReviews(
  product: ProductDetail,
  question: string,
): Promise<{ reply: string; evidence: EvidenceChunk[] } | null> {
  const words = wordsOf(question);
  const asksForReviews =
    // "rated" and "rating" share only three characters, so both stems are
    // listed rather than loosening the prefix for everything.
    words.some(
      (w) =>
        looselyMatches(w, "review") ||
        looselyMatches(w, "rating") ||
        looselyMatches(w, "rate") ||
        looselyMatches(w, "star") ||
        looselyMatches(w, "feedback") ||
        looselyMatches(w, "opinion"),
    ) ||
    (words.some((w) => looselyMatches(w, "people") || looselyMatches(w, "buyers") ||
      looselyMatches(w, "others") || looselyMatches(w, "customers")) &&
      words.some((w) => looselyMatches(w, "said") || looselyMatches(w, "say") ||
        looselyMatches(w, "think") || looselyMatches(w, "thought")));

  if (!asksForReviews) return null;

  const { chunks, total, averageBp } = await reviewSample(product.productId, 3).catch(() => ({
    chunks: [] as EvidenceChunk[],
    total: 0,
    averageBp: null,
  }));

  if (chunks.length === 0) {
    return { reply: `${product.title} has no reviews yet.`, evidence: [] };
  }

  const stars = averageBp ? (averageBp / 1000).toFixed(1) : null;
  const summary = stars
    ? `${product.title} averages ${stars}/5 across ${total} review${total === 1 ? "" : "s"}. Here are a few:`
    : `Here are a few of the ${total} review${total === 1 ? "" : "s"} for ${product.title}:`;

  return { reply: summary, evidence: chunks };
}
