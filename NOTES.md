# NOTES.md — Agentic Commerce Platform

Durable project knowledge. Read this and `PROGRESS.md` before doing anything.

---

## 1. What this is

A **multi-merchant, AI-native marketplace**. Merchants publish once and become discoverable and
transactible by AI buyers; shoppers describe what they want in plain language and an agent searches
every merchant's machine-readable catalog, ranks the options, explains its choice, and asks
permission before spending money.

**Hard constraint, stated by the user and non-negotiable:** every dependency — AI, database, auth,
storage, hosting, payments — must run on a free tier **without providing credit-card details**.
This rules out paid LLM APIs and Stripe live mode, and drives several architectural choices.

**Second hard constraint:** the user develops on an **M1 MacBook** and does not want heavy models
consuming local compute. All LLM inference is remote. The only local model is a 22M-parameter
sentence embedder (~4ms/query, measured) — deliberately small and justified. **Ollama is opt-in
only** (activates solely when `OLLAMA_BASE_URL` is explicitly set) so a local LLM can never start
by accident.

Repo: `https://github.com/ParthTripathi450/agentic-commerce-platform` (**private**).

---

## 2. The central architectural idea

> **The LLM is not the search engine, the ranker, or the executor. It is the interpreter and the narrator.**

```
NL query ──LLM──> structured intent ──Postgres (pgvector + weighted FTS + filters)──> candidates
                                     ──deterministic scorer──> ranked, per-criterion scores
                                     ──LLM──> explanation generated FROM those scores
                                     ──policy engine──> ALLOW | REQUIRE_APPROVAL | DENY
                                     ──AP2 mandate chain──> payment
```

Two LLM calls per shopping turn, not twenty. This survives free-tier rate limits, but it is also
simply correct: the "why I picked this" text is generated **from** the score vector, so it cannot
invent a reason the ranker did not use. Ranking, policy checks and mandate verification are pure,
unit-testable functions.

**Never** let the model decide what to buy, what ranks first, or whether a payment may proceed.

---

## 3. Stack

| Layer | Choice | Notes |
|---|---|---|
| App | Next.js 15.5.25 App Router, React 19, TypeScript | Serves UI **and** MCP/UCP/ACP/x402 endpoints |
| DB | Postgres 17 + **pgvector** via Drizzle ORM | Local dev; Supabase free tier is the deploy target |
| Auth | Auth.js v5 (`next-auth@beta`), credentials + bcrypt | JWT sessions (Auth.js can't do DB sessions with Credentials). Route protection is in server layouts via `auth()`, **not** middleware — keeps bcrypt/pg off the edge runtime |
| UI | shadcn/ui (**Base UI**-backed, not Radix) + Tailwind v4 | See §8 for the Base UI gotcha |
| LLM | Groq primary, failover to Gemini/OpenRouter/Cerebras | All no-card free tiers |
| Embeddings | `@huggingface/transformers`, `Xenova/all-MiniLM-L6-v2`, 384-dim | Local CPU, no key, no rate limit |
| Payments | Razorpay **test mode** behind a `PaymentGateway` interface + mock impl | Never live keys |
| Images | Pollinations (free, no key) | Generated product photography |
| Charts | Recharts (revenue only) + hand-rolled inline-SVG sparklines | |
| Tests | Vitest, integration against the real local DB | |

---

## 4. Directory map

```
src/
  app/
    (auth)/login, register           auth pages, elevated form cards
    (app)/                           authenticated shell (dark sidebar + light content)
      shop, browse, for-you, product/[id], cart, checkout, orders,
      reviews, preferences, support, activity, settings/limits
      merchant/  (overview, products, products/[id], products/new, orders,
                  promotions, insights, support, protocols, settings)
    api/
      agent/shop            POST  assisted shopping turn
      agent/autonomous      POST  full autonomous run, stops at approval
      commerce/{cart,checkout,authorize,confirm,pay-saved}
      webhooks/razorpay     POST  signed webhook receiver
      mcp                   POST  MCP over Streamable HTTP (stateless JSON-RPC)
      ucp/[merchant]/manifest, acp/[merchant]/feed.json, x402/insights/[merchant]
    .well-known/ucp         platform-level UCP discovery
  db/
    schema/                 _shared, auth, merchant, catalog, commerce, agent,
                            reviews, support, payment-methods, index (barrel)
    seed.ts                 DESTRUCTIVE full seed (truncates everything)
    seed-extra.ts           ADDITIVE expansion (safe to re-run, preserves users)
    migrate.ts, reset.ts
  server/
    agents/customer/        agent.ts (state machine), intent*, ranker, explain,
                            autonomous.ts, dto.ts, affinity.ts, purpose.ts,
                            refine.ts, alternatives.ts
    agents/merchant/        agent.ts (insights), detectors.ts,
                            product-assistant.ts, listing-actions.ts
    catalog/                search.ts, browse.ts, evidence.ts, indexer.ts, normalize.ts,
                            vocabulary.ts, featured.ts, actions.ts,
                            image-actions.ts, attributes.ts, facets.ts,
                            create-product.ts (THE single writer)
    shopper/                knowledge.ts (the taste profile), for-you.ts,
                            signals.ts, actions.ts
    commerce/               cart.ts, checkout.ts, gateway.ts, webhooks.ts,
                            expiry.ts, cart-actions.ts, refund.ts, test-utils.ts
    policy/engine.ts        the single gate for every consequential action
    protocols/              ap2/{keys,mandates}, mcp/{server,tools},
                            ucp/manifest, acp/feed, x402/facilitator
    ai/                     llm/ (router + providers), embeddings.ts, images.ts
    audit/recorder.ts       append-only agent event log
    analytics/merchant.ts   all dashboard aggregation (SQL, not JS)
    payments/, reviews/, support/, storage/, merchant/
  components/
    ui/                     shadcn primitives + app adapters (see §8)
    shop/, cart/, merchant/, reviews/, support/, brand/
  scripts/                  doctor, index-catalog, generate-images, mcp-stdio
```

---

## 5. Data model (32 tables)

Core: `users, accounts, sessions, verification_tokens, signing_keys`
Merchant: `merchants, merchant_policies, promotions`
Catalog: `products, product_variants, inventory, availability_windows, catalog_documents`
Commerce: `carts, cart_items, checkout_sessions, orders, order_items, payments, webhook_events`
Agent/governance: `agent_sessions, agent_events, mandates, agent_policies, approvals, insights`
Social: `product_reviews, merchant_reviews, support_threads, support_messages`
Payment: `payment_methods`
Shopper: `shopper_signals` (weak interest signals — searches, filters, product views)

**Conventions:**
- **All money is an integer in MINOR units** (paise). Never floats. `src/lib/money.ts` has
  `toMinor`, `toMajor`, `formatMoney`, `applyBp`. Percentages are basis points (1bp = 0.01%).
- Ratings are `ratingBp`: 1000–5000 (i.e. 4.6★ = 4600).
- `agent_events` is **append-only** — never updated or deleted.
- `catalog_documents.search_vector` is a **generated column** with weights:
  `setweight(title,'A') || setweight(tags,'A') || setweight(ai_text,'B')`.
  `title_text` and `tags_text` are populated by the indexer.

---

## 6. Key subsystems

### Search (`server/catalog/search.ts`)
Hybrid recall: pgvector cosine + Postgres FTS, fused by **Reciprocal Rank Fusion** (k=60). Then
hard filters (attributes, price, stock, sale window, merchant allow/deny) applied against live data.
Rejected products are returned in `rejected[]` **with a specific reason** — that is what lets the
agent say why the cheap option wasn't chosen.

**The lexical leg ORs its terms when ANDing them finds nothing.** `websearch_to_tsquery` ANDs
everything, which silently killed the entire lexical half of the "hybrid" search for conversational
input: "shoes I can play tennis in" required all those words together and matched **0 of 503**
documents, while "tennis" alone matches exactly the 13 court shoes. Every natural-language query —
the primary way anyone talks to this agent — was therefore ranked by the embedding alone. AND stays
first because it is right for keyword input and the eval says so (forcing OR everywhere cost 0.011
recall); the OR fallback fires only when AND matched nothing, and carries `LEX_FALLBACK_CONFIDENCE
= 0.4` in the fusion because a broad term like "shoes" matches a third of the catalogue.

**`tagsText` carries the purpose attributes, not just `searchTags`.** `searchTags` is empty for every
seeded product, so the weight-'A' band went unused while `useCase` — the one field that says what a
product is FOR — sat in `ai_text` at weight 'B'. `useCase`, `use`, `style`, `activity`, `fit` and
`features` are now promoted. This is weighting, never filtering: §8.8 is about a GUESSED category
becoming a hard filter, whereas this ranks a field the merchant wrote and can never remove a product.

**Relevance gate (anti-hallucination):**
- `MIN_TOP_RELEVANCE = 0.34`. Measured on this catalog: stocked items score 0.369–0.721 for a plain
  description; unstocked queries top out at 0.307. 0.34 sits in that gap.
- **Judged on what RETRIEVAL found (`bestRecalled`), not on what survived filtering.** Otherwise a
  wrong filter is indistinguishable from an empty catalog.
- When `noRelevantMatch` is true, the agent must **not** relax constraints — relaxing only surfaces
  unrelated products.

### Ranker (`server/agents/customer/ranker.ts`) — no LLM
Seven weighted criteria: relevance, price, availability, delivery, returns, reliability, rating.
Presets (each sums to 1.0): balanced / cheapest / fastest / best_quality / most_flexible.
Ratings use **Bayesian shrinkage** (`RATING_CONFIDENCE_REVIEWS = 50`) so a 5.0 from 3 reviews cannot
beat a 4.6 from 900. Every criterion reports `weight × normalized = contribution`.

### Explanation (`server/agents/customer/explain.ts`)
Returns `points: string[]` (3–5 short bullets), not prose. The model sees **only** the computed
criteria as human-readable phrases — never raw scores or weights. A test asserts no point ever
contains a decimal like `0.9957`.

**It also carries what buyers said about the pick, and the model never touches that text.** The
obvious way to use retrieved reviews is to hand the sentences over and ask for a summary; it is the
wrong way. This model's one guarantee is that it adds no facts, and a paraphrase of a review is a
new claim attributed to a real person who did not make it — a different and worse class of error
than a clumsy score narration. So `retrieveEvidence` runs in code, scoped to the winning product and
asked with the shopper's OWN phrasing (reviews are prose, and a shopper's sentence retrieves against
prose better than a criterion name), and the quotes ride on `Explanation.evidence` to be rendered
verbatim beside the points. The model narrates the ranking; the buyers speak for themselves. A test
asserts every quoted body matches a stored chunk byte for byte.

The contrast is the point: the model produces *"rated 4.6/5 from 11 customer reviews"*; the corpus
produces *"No slipping at all, even on polished floors."* One is a statistic, the other is a reason.
Evidence is an improvement to an explanation, never a precondition for one — a product with no
reviews still gets its reasons.

### Policy engine (`server/policy/engine.ts`)
`evaluatePolicy(action, ctx) -> { verdict, reason, boundsChecked, violations, limits }`.
Called before every money-moving or catalog-mutating action.
**Platform limits are a CEILING, not a default** — a user/merchant scope can only be stricter.
Defaults: ₹50,000/order, ₹100,000/day, `requireApprovalAboveMinor: 0` (every payment needs consent).

### AP2 mandates (`server/protocols/ap2/`)
Intent → Cart → Payment, ES256 JWS over canonicalised JSON, each child embedding the SHA-256 of its
parent. `verifyMandateChain()` checks signatures, expiry, status, hash links, and that the cart
honours the intent. Cart Mandates are signed by **both** merchant and shopper.
**`maxAmountMinor` (total charged) is distinct from `maxItemPriceMinor` (what the shopper said about
the product)** — "under ₹5,000" is about the item; ₹4,299 + 18% GST is ₹5,072 and must not be refused.

### Payments (`server/commerce/gateway.ts`, `server/payments/`)
`PaymentGateway` interface with `RazorpayGateway` (test-only; **throws if the key is not `rzp_test_`**)
and `MockGateway`. `confirmPayment()` takes an optional explicit `gateway` — saved-method purchases
pass `new MockGateway()`. **Never mutate `process.env.PAYMENT_GATEWAY` to switch gateways**; the
server is concurrent and it races with widget checkouts.
`payment_methods` holds **no credentials** — no card number, CVV or token columns exist, and a test
asserts that. Enabling a method generates fabricated display metadata server-side.

**Refunds** (`server/commerce/refund.ts` + `refundOrderAction`): full-amount only, refunded through
`gatewayByName(payment.gateway)` — **the rails the charge came in on, not the configured default**,
because saved-method purchases settle on `MockGateway` even while `PAYMENT_GATEWAY=razorpay`.
Eligibility and the stock decision are pure functions, and the stock decision differs by state:
`paid` restocks (units never shipped), `fulfilled` does **not** (they were delivered), `canceled`
does **not** (`cancelOrderAction` already returned them). The `refund.processed` webhook marks state
but never touches stock — it cannot tell a dashboard refund from one issued here, and
over-restocking sells phantom units while under-restocking is fixable by hand.

### Product creation (`server/catalog/create-product.ts`)
**One writer, two parsers.** The manual form and the assisted wizard parse genuinely different
input (typed `key: value` lines + one variant vs. model-suggested JSON + N variant axes), but both
write through `createProductWithVariants()`. They had already drifted three ways — only the wizard
set `searchTags`, the SKU builders were duplicated, and only the wizard bounded the variant count.
The writer owns validation, SKU reservation, inventory and re-indexing; the actions above it do
auth, parsing and redirects only. `deriveSearchTags()` gives the manual path deterministic tags
with **no LLM call**, so that form keeps working when the model is rate-limited.

### Conversational shopping (`server/agents/customer/conversation.ts`)
**Where it lives:** the big chat transcript is the **"Let the agent buy it for me"** flow
(`autonomous-flow.tsx`), not `/shop`. Assisted shopping keeps its compact search box — the shopper
who already knows what they want should not have to converse for it. The agent flow talks first
because it acts on ONE instruction, so that instruction had better be right; the phrase it
synthesises from the conversation is what the autonomous run then buys.

One LLM call per turn reads the WHOLE
conversation and returns: what it understood (slots, `null` for anything unstated), whether it can
search honestly yet, and the next question **in its own words**. There is no keyword matching on
replies — "something for pounding pavement at weekends" and "road running" land in the same place
because the model understood them.

Split of responsibility:
- **Understanding is the model's.** Extracting purpose/size/colour/budget from natural language,
  judging what is missing, phrasing the question, and writing the semantic `searchPhrase`.
- **Deciding is bounded.** `MAX_TURNS` is enforced in code, not left to the model; an unstated slot
  must come back `null`; colour/size suggestions are intersected with live variant axes.
- **`category` is never set from understanding** — §8.8 stated precisely: the bug was not "the model
  misunderstood", it was "a guessed category became a hard filter". Purpose reaches retrieval
  through the semantic phrase; only what the shopper actually stated becomes a filter.

This call **replaces** `parseIntent` on the happy path — it already extracts everything that step
did, and two calls per turn doubled free-tier token burn for no extra information. `clarify.ts` and
`parseIntentWithRules` survive only as the no-LLM fallback (§9), which is why that fallback intent
is rule-parsed rather than empty.

**Autonomous mode passes `skipQuestions: true`** — nobody is at the keyboard to answer.

### What a product is FOR (`server/agents/customer/purpose.ts`)
Relevance cannot separate a leather dress shoe from a leather sneaker — they are genuinely close in
both embedding and keyword space — so "formal shoes for the office" put Court Sneakers second, ahead
of three dress shoes, on a margin of 0.010. The catalogue is not ambiguous though: the dress shoe
carries `use: "formal"` and a feature called "interview"; the sneaker carries
`useCase: "everyday wear and casual court style"`. It declares itself casual, and nothing was reading
that.

`purposeMatch()` scores the overlap between the request and the purpose fields the MERCHANT wrote
(`useCase`, `use`, `style`, `activity`, `occasion`, `fit`, plus `features`), carved into the ranker at
`PURPOSE_WEIGHT = 0.1` — a tie-breaker between things relevance already judged comparable, never more.

Three rules keep it safe:
- **It ranks, never filters.** §8.8 is about a *guessed* category becoming a hard filter; this scores
  published text and cannot remove a product from consideration.
- **Silence is neutral (0.5), never negative.** Around a third of the catalogue publishes no purpose
  text — the Windshell Packable Running Jacket has none and is a correct answer for "a warm winter
  jacket". Penalising absence is a data-completeness bias dressed up as relevance.
- **`features` may EARN a match but never trigger the mismatch penalty.** "interview" genuinely
  answers "for the office", but "reflective trim" is not a statement of purpose, and counting it as
  one marked down every product that listed features and no purpose.

Scored on the share of the QUERY's words accounted for, so a long marketing sentence cannot outscore
a precise one by length.

### Shopper-controlled ranking (`ranker.ts` + `priority-editor.tsx`)
The weights are **shown, not hidden** — a ranking whose priorities are invisible cannot be argued
with. `SHOPPER_CRITERIA` (price, rating, delivery, returns, reliability, availability) can be
reordered by drag OR by up/down buttons; the buttons are the real control, since drag-and-drop is
unusable by keyboard. `weightsFromOrder()` is rank-proportional, so reordering shifts the ranking
without collapsing it into a single sort key, and a partial order is still valid.
**`relevance` is not in the list** — it is not a preference, it is what keeps results about the
thing that was asked for. **That is enforced, not just stated:** `withFocus` and
`withAffinity` carve their share out of the PREFERENCES only and leave relevance untouched. They used
to scale it down like everything else, so a shopper who asked for tennis shoes, chose "comfort" and
had a taste profile got relevance weighted at 0.142 — at which point a cheap, comfortable casual
sneaker outscores an actual court shoe, which is exactly what happened. A reorder replays the query rather than re-sorting client-side, so the
score breakdown and explanation are regenerated from the new weights.

### Refining one product (`server/agents/customer/refine.ts`)
**Four kinds of question, and only one of them is a semantic search.** The catch-all fallback was
silently answering three of them with a recital of price and stock:
- *"what colours does it come in?"* — read off this product's OWN live variant axes, so a catalogue
  that starts selling by width answers that too without a code change. Only in-stock values are
  named, because naming one is a promise it can be bought.
- *"what's the return policy?"* — matched against the policy fields the merchant publishes, so the
  answer is this merchant's terms rather than a general statement.
- *"what are the reviews like?"* — a question about the CONTAINER, which retrieval cannot serve:
  reviews talk about shoes, not about reviews, so it scores **0.311** against its own corpus where
  "is it comfortable" scores **0.553**. The relevance floor rejects it correctly and nine real
  reviews stay unreachable. `reviewSample()` returns a sample instead of running a search, and
  returns it **balanced** — the critical review first where there is one, because an agent whose job
  is to sell has to be trusted to say the bad part.
- *"is it breathable?"* — the actual semantic case, answered from `evidenceByTopic`.

Quotes ride on `RefineResult.evidence` rather than being baked into the reply string, so the UI can
render them as what they are: someone else's words, verbatim, with their rating.


Once a shopper has chosen, their questions narrow — "in navy instead", "do you have an 11?",
"is it breathable?" — and answering those with a fresh catalogue search is wrong twice: it can
wander to a different product, and it discards the choice they already made. So the model reads the
request and **code resolves it against THIS product's real variants**, which means the answer can
only ever be something that exists.

`resolveVariant` keeps whatever was not asked about (changing colour must not silently change size),
prefers in-stock over out-of-stock, and when the combination does not exist it **refuses and names
the real options** rather than returning the nearest thing. It distinguishes "we have no purple"
from "we have white, but not in a 9".

Two matching details that were wrong first time: the extractor must return a colour the shopper
asked for **even when the catalogue lacks it** (dropping the word makes the refusal impossible), and
feature questions match on a shared 5-character prefix in either direction — "breathable" must reach
`breathability`, which neither exact matching nor suffix-stripping achieves.

### Selling a substitute (`server/agents/customer/alternatives.ts`)
**The agent's job is to sell**, so an empty result is a lost sale — but only one kind of empty
result may be recovered:

| | |
|---|---|
| `noRelevantMatch = true` | Catalogue does not stock this KIND of thing ("a gaming laptop"). **No alternatives** — offering shoes is the hallucination §6 exists to prevent. |
| `noRelevantMatch = false` | We stock it; a hard filter removed every option ("size 15", "purple formal shoes"). **Alternatives belong here.** |

Alternatives are never presented as matches: each carries `differences[]` stating exactly how it
differs ("no size 15 — available in 7, 8, 9, 10, 11"). Availability claims are **queried from live
variants**, not read off `candidate.variant` — that is one variant, so a list built from it would be
true of no individual product. Stock is never relaxed: an unbuyable alternative is not an
alternative.

**Closeness is weighted by KIND of difference, never counted.** Counting was actively backwards: a
navy rucksack offered against "navy running shoes" matches on colour and therefore has one FEWER
difference than the same running shoe in black, so counting ranked the rucksack first. A different
category costs 100, brand 8, price 6, size 4, colour/style/width 1 — so the right kind of product
wins however many small things it gets wrong, and no amount of soft-attribute matching buys a wrong
category back.

Two supporting rules:
- **A dropped constraint must stop steering RETRIEVAL, not just stop filtering.** Clearing
  `attributes` removes the hard filter while "navy" sits in the semantic phrase, so the embedding
  goes and finds navy things of any kind. The word is stripped from the query text too — the same
  failure as a focus answer leaking into the query and turning a search for shoes into shorts.
- **The anchor comes from `attribute_mismatch` rejections only, thresholded by share.** Those
  products matched everything except the colour, so they are the right kind of thing by
  construction. The whole rejected set will not do: "magenta backpack" recalls 60 products across
  seven categories including Hoodies, because recall is meant to be generous, and anchoring on all
  of it waves a hoodie through. Categories below 15% of the attribute rejections are recall noise.
  A stated `query.category` is definitive and wins outright; no anchor at all means category costs
  nothing rather than being guessed.

### Suggestion chips (`server/catalog/facets.ts`)
Chips are a promise — tapping "Black" must lead to black shoes buyable today. `computeFacets()`
counts live variants joined to live inventory, scoped to the products the search recalled (so
"100ml" is never offered as a shoe size). **Price bands are quartiles of the real distribution**,
never hardcoded: fixed bands either bunch everything into one bucket or offer empty ones. Every band
shown contains stock. **Budget is always asked, and asked last** — a price band is the most useful
thing a shopper can tap, and asking last means the bands are computed from products they might
actually buy. Two deterministic guards sit over the model: a repeated question is caught and
redirected, and a chip row is never rendered empty (`optionsForSlot` fills gaps for purpose/gender,
which are needs rather than countable attributes).

### The synthetic dataset (`db/catalog-blueprints.ts`, `catalog-generator.ts`)
503 products, 4,008 reviews, 57 categories, 21 merchants. Generated, not sampled — and the point is
**coherence, not volume**. Every product is composed from an archetype (what it IS) × a material
(what it is MADE OF) × a brand tier (how well it is made), and its description, its 1–5
`qualities` scores and its reviews are all written from those same three facts. A mesh trainer
therefore scores breathability 5 / water resistance 1, says so in its description, and collects
reviews complaining about wet feet — prose, attributes and opinion cannot contradict each other.
A dataset where they do is worse than none: retrieval learns the false association and nothing
downstream can see it.

Brands are invented. Attaching fabricated durability scores to real manufacturers would make the
data misleading the moment it is screenshotted.

**Reviews are authored by a dedicated pool on `@marketplace.reviews`**, never by test accounts:
`provisionTestShopper()` deletes all its user's orders and reviews cascade from orders, so
attributing the corpus to a test shopper means `npm test` silently destroys it. It already did once
— 861 reviews vanished on the first suite run, leaving orphaned embeddings.

### RAG retrieval (`evidence_chunks`, `server/catalog/evidence-indexer.ts`)
Reviews are embedded as their **own** chunks rather than folded into the product document.
`catalog_documents` answers "which product?" with one vector each; averaging forty opinions into
that would blur the product's identity and match neither specs nor reviews well. Separate chunks
let "do these run hot in summer?" retrieve the sentence that answers it and cite its source.

**Rated features are a PREDICATE, not a similarity signal.** `qualityConstraints` on
`StructuredQuery` become a SQL pre-filter inside both recall legs. The evidence for doing it this
way came from the eval itself: single-attribute queries scored 0.629 while trade-offs scored 0.338
on the *same* corpus and embedder — the gap is logic, not semantics, and no bi-encoder represents
"at least 4 out of 5" or distinguishes "waterproof AND breathable" from "waterproof but NOT
breathable". The model extracts the constraint from language (what it is for); SQL applies it (what
it is for). Two decisions that were measured, not guessed:

- **Pre-filter, not post-filter.** Filtering after recall only narrows what similarity already
  chose, so a qualifying product ranked 80th stays lost — trade-off stalled at 0.438 that way.
- **A missing quality key EXCLUDES the product.** Every product carries scores for the qualities its
  category is measured on, so an absent key means the quality does not apply (a t-shirt has no water
  resistance rating). Tolerating NULL let every unscored garment through `packability <= 2` and
  pinned trade-off at 0.438. If the constraint is too tight, the relaxation path drops it and says
  so — the honest way to widen.

**The retrieval layer is `server/catalog/evidence.ts`, and it is wired into four places:** the
agent's own explanation (`explain.ts` — buyer quotes beside the ranking's reasons, on `/shop` and on
the autonomous flow's authorisation screen, which is the one screen a shopper reads before money
moves), the
product page (`evidenceByTopic` — the qualities a category is rated on become the questions asked of
the corpus, so each score is shown WITH the sentence that evidences it), the product chat
(`refine.ts` answers "will my feet get hot?" by quoting a buyer instead of reciting `breathability:
4`), and any caller needing `productsByEvidence`. `MIN_EVIDENCE_SCORE = 0.34` mirrors the catalogue
relevance gate for the same reason — a model handed the nearest three sentences will summarise them
however irrelevant, so "nothing close enough" must be a returnable result. **Nothing here generates
text**: sentences are returned verbatim with their reviewer's rating, so every claim traces to a
person who wrote it.

`evidenceByTopic` assigns each chunk to its ONE best topic rather than each topic to its best chunk.
Within a product every review is written in the same register about the same object, so they score
similarly against every question, and the per-topic argmax put the same sentence under comfort,
support, durability and breathability at once.

**Evidence is NOT a search recall leg, and that was measured rather than assumed.** Adding it as a
third RRF leg moved overall recall 0.772 -> 0.769 and paraphrase 0.280 -> **0.260**; restricting it
to praise-only reviews made paraphrase worse again at 0.250. Both were reverted. The cause is worth
keeping: **embeddings have no notion of polarity or desire.** "My feet get unbearably hot" retrieves
"the warmth is the selling point — warmer than its weight suggests" as its best match, on a product
scoring `breathability: 1`, because *hot* and *warmth* are semantic neighbours while being opposite
in intent. Review prose is dense in exactly that vocabulary, so the evidence leg amplified the
confusion. The thing that fixes paraphrase is extracting the DESIRED quality from the stated need
("hot feet" -> `breathability >= 4`), which is the model's job via `qualityConstraints` — not more
retrieval.

**The eval set is the point** (`npm run eval:generate`, `npm run eval:retrieval`). Ground truth is
computed from the same quality scores that generated the catalogue, so it is exact rather than
hand-judged. Baseline at k=10: **overall recall 0.772, MRR 0.796** — category 0.894, attribute
0.833, trade-off 0.688, negation 1.000, **paraphrase 0.280**.

Two properties the harness must keep:
- Expected sets must be COMPLETE, never sampled. An early version capped them at 40 rows and
  measured the wrong thing entirely: 178 products qualify as breathable, so retrieval could return
  ten genuinely breathable shoes and score zero.
- **`paraphrase` cases carry NO constraints on purpose.** They describe a need without naming the
  feature ("my feet get unbearably hot"), so no predicate can be extracted and retrieval has to do
  the work alone. Without them, adding a filter would score ~1.0 by construction and the eval would
  have stopped measuring anything. That 0.280 is the honest ceiling of the 22M embedder, and it did
  NOT move when filtering was added — which is exactly right, and is where a stronger model would
  earn its keep.

### Browsing the catalogue (`server/catalog/browse.ts` + `/browse`)
**Deliberately not the agent's search.** They answer different questions: the agent answers "what
should I buy?", so it ranks semantically, gates on relevance and refuses when the catalogue does not
stock the kind of thing asked for. Browse answers "show me everything, let me narrow it", so it must
be exhaustive, exactly countable and stably paginated.

That rules out the embedding path here — cosine similarity has no honest notion of "how many match",
so there is nothing to count and no natural end to the list. Browse is **SQL only**: no embedding
call, no LLM call, no relevance gate. An empty result is the honest answer, because browse never
claims a match.

- **Facet counts are promises.** Each facet is counted with every filter applied EXCEPT its own, so
  "Running Shoes (45)" means 45 results if you tick it. A test asserts the promise is kept, and that
  the category facet partitions the result set exactly.
- **Price bands are quartiles of what is currently on screen**, same rule as the suggestion chips,
  and each is counted in the same pass. Bands abut at one paise, so the lower bound is rounded up
  for the LABEL only — the paise-exact value stays in the URL.
- **Price filters bite on the price actually shown** — the cheapest buyable variant. Filtering on any
  variant's price surfaces products whose affordable size is out of stock.
- Text matching reuses the weighted `search_vector`, widened with an ILIKE: stemming gets "shoes" to
  "shoe" but never "veloc" to "Velocity", and a browse box is typed into a character at a time.
- **Every filter lives in the URL**, so a filtered view is shareable and the back button works.

### The shopper knowledge base (`server/shopper/knowledge.ts`)
What we have learned about one shopper, derived **entirely from what they did** — nothing declared by
them, nothing invented by a model. Every preference can name its evidence, because a profile whose
reasoning cannot be shown is one the shopper cannot correct and the agent should not act on. It is
visible in full at `/preferences`, with charts.

**Actions are weighted by what they cost to take**: review (±5/−6) → purchase (+4) → basket (+2) →
browse (+1), decayed on a 120-day half-life. A poor review outweighs a purchase deliberately — it is
the shopper correcting a decision they already made, and if it did not outweigh it, buying-then-
hating would still read as a like. Neutral reviews are dropped: "it was fine" is not a preference.

**Preferences are a ranking nudge, never a filter.** `withAffinity()` gives history 15% of the score,
mirroring `withFocus()` and applied after it, so what the shopper says now beats what we inferred
earlier. Two properties keep it from becoming a filter bubble:
- **0.5 is the neutral score, not 0.** An unfamiliar product scoring 0 would make this a 15% penalty
  on everything new, and the agent would quietly stop showing anything they had not already bought.
- **Axes are averaged, never summed.** Brand + merchant + colour all matching is usually one past
  purchase restated three times.
Budget is capped at half an axis's weight — almost every product sits inside a shopper's usual range,
so unweighted it swamped everything and the criterion stopped discriminating.

The conversation model gets the profile as **prose, never scores** (same rule as `explain.ts`), and
is told it may use it to ask better questions but **must not fill a slot from it** — someone buying
a gift, or simply changing their mind, would otherwise get a search built from a preference they
never stated and cannot see.

`shopper_signals` holds only the browsing half, and only the shape of the interest — no session id,
IP, referrer or user agent. Views dedupe over 30 minutes, and `deleteShopperSignals` empties it.
Orders and reviews are NOT erasable there: they are records of real transactions, not preferences we
inferred.

### Suggestions from the profile (`server/shopper/for-you.ts` + `/for-you`)
The failure this is designed against is a "for you" page that is a **mirror** — a shopper who bought
running shoes shown nothing but running shoes, from the brand they already own. Three rules:

- **Nothing they already own.** `NOT EXISTS` against their own paid and fulfilled orders. The
  largest source of embarrassing suggestions and the cheapest to remove.
- **Every shelf states which part of the profile built it, and every CARD carries its own reason**
  from `affinityFor`. A shelf can only say what it is broadly about; the card says why this one.
- **One shelf deliberately leaves their categories.** Qualities are the portable part of a profile —
  "likes breathable, packable things" is as true of a jacket as a shoe — so the discovery shelf ranks
  on qualities alone and EXCLUDES what they usually buy. Without it the page is a mirror however well
  the rest is built, because their usual categories score highest on every other axis.

Ranking uses the same `affinityFor` the agent's ranker uses. Two places scoring "fits you"
differently is how a recommendation comes to contradict the ranking that follows it. A cold shopper
gets an honest empty state, never bestsellers relabelled as "picked for you".

### Recommendations (`server/catalog/recommendations.ts`)
Two different questions, two sources. **`alsoBought`** is real co-purchase from `order_items` — what
shoppers actually put in the same order, so it surfaces genuine complements (a t-shirt with running
shoes). **`similarTo`** is nearest-neighbour on the same pgvector embeddings search uses, so
"similar" means the same thing everywhere. Both require live stock; both dedupe by title, because a
product stocked by several merchants otherwise fills every slot with itself.

### Cart ownership
`carts.agentSessionId` distinguishes a basket the AGENT assembled from one the shopper built, and
that distinction is load-bearing: on a declined payment the agent's basket is discarded
(`discardAgentCart`) while the shopper's survives — declining a payment is not the same as changing
your mind. `startDirectPurchase` creates its OWN cart; it used to reuse the shopper's open cart for
that merchant and delete everything in it.

**There is one route into the cart** (`addToCart`). "Buy now" was a second path with its own basket
and modal, which is exactly where the lingering-item bug lived.

### Group checkout### Group checkout (`server/commerce/group-checkout.ts`)
One payment across merchants. Carts stay per-merchant because fulfilment, returns and the AP2 Cart
Mandate all are — a merchant can only sign for their own basket. The group is the **settlement**
unit: N Cart Mandates, N orders, **ONE** gateway order, and one payment row per order sharing its
id so refunds stay per-merchant. `authorizeCheckout({ deferPayment: true })` builds an order
without touching the gateway; the group layer then creates the single charge.
**The combined total is re-checked against the policy limits.** Per-cart checks all measure against
the same "already committed today" figure, so baskets that each fit the remaining headroom can
exceed it together — without the group check, splitting a purchase across merchants would be a way
to spend past a daily limit. Baskets that cannot be included are returned in `excluded` and shown,
never silently dropped from a combined total.

### Protocols
- **MCP**: 6 tools, stdio (`npm run mcp:stdio`) + stateless JSON-RPC at `/api/mcp`. No tool can
  charge; `prepare_purchase` returns an authorization URL.
- **UCP**: `/.well-known/ucp` + per-merchant manifest with capabilities, payment handlers and the
  merchant's **public** signing key (private material must never appear).
- **ACP**: product feed JSON/CSV — this **is** the AI-readable catalog; nothing is hand-authored.
- **x402**: HTTP 402 challenge + signed retry, mock facilitator (no wallet or funds).

---

## 7. Conventions

- **Read queries must not live in `"use server"` files** — every export there becomes a POST
  endpoint. Pattern: `foo/actions.ts` (mutations) and `foo/queries.ts` (reads).
- Comments explain **why**, not what. Prefer a short comment on a non-obvious decision over none.
- Server actions return `{ ok, message }` or `{ error }`; never throw for expected outcomes.
- All aggregation happens in SQL, not JavaScript.
- Model output passes through `normalizeTypography()` (`src/lib/text.ts`) — models emit U+202F and
  non-breaking hyphens that break exact string matching.
- Every status colour ships with a **word**, never colour alone.

---

## 8. Hard-won gotchas (do not re-learn these)

1. **`formData.get()` returns `null`, Zod `.optional()` accepts `undefined`.** This silently broke
   customer signup for days. Use the `optionalField()` helper in `src/lib/registration.ts`.
2. **`String.replace()` fails silently** when the anchor doesn't match. After any scripted patch,
   `grep` the file to confirm it applied.
3. **Never declare `box-shadow` on `[data-slot="card"]` in CSS** — Tailwind compiles `ring-*` into
   `box-shadow`, so a raw declaration erases every ring. Elevation lives in the Card's utilities.
4. **`border-primary` alone shows nothing** — shadcn's Card has no border *width*. Use `border-2`.
5. **This shadcn build is Base UI, not Radix**: composition uses `render={<X/>}`, not `asChild`,
   and rendering a non-button needs `nativeButton={false}`. Use the `LinkButton` helper.
6. **Groq rotates its model catalogue.** `llama-3.3-70b-versatile` was decommissioned mid-build.
   Model IDs are env-overridable; `npm run doctor` verifies them.
7. **`gpt-oss-*` are reasoning models** — they spend the token budget thinking and return an *empty*
   completion if it is too small. Use `maxTokens >= 1200` and `reasoningEffort: "low"`.
8. **Safety-relevant intent fields are rule-owned, not model-inferred.** Two have bitten so far:
   - **category** — the model guessed "Activewear" for "yoga mat" (they're Fitness Accessories) and
     the hard filter buried every mat.
   - **requireInStock** — gpt-oss intermittently returned `false` for a plain request, silently
     widening the search to products nobody can buy.
   Both now come from `intent-rules.ts` and override the model in `intent.ts`. Apply the same rule
   to any future field where a wrong value changes what the shopper is allowed to see or buy.
9. **Dark mode is opt-in (`.dark` class), never `prefers-color-scheme`** — the design is a dark
   sidebar on a *white* page; following the OS setting blacked out the whole app.
10. **Drizzle can emit migrations in an impossible order** (it recreated a generated column before
    the columns it references). Always read generated SQL before applying.
11. **Integration tests mutate real data.** Use `provisionTestShopper()` + `ensureStock()` +
    `emptyOpenCarts()` from `server/commerce/test-utils.ts`, and `fileParallelism: false`.
12. Free-tier LLMs rate-limit under test load; tests must tolerate `degraded: true`.
12. **Every LLM path has a deterministic fallback, and the fallback is a *normal* path, not an
    edge case** — Groq rate-limits regularly, and `buildFallbackDraft()` is then what the merchant
    actually sees. A change to the model path that is not mirrored in the fallback is a bug:
    that is precisely how the wizard shipped *"Nike Nike Air Zoom Pegasus"*. Shared logic belongs
    in a helper both call (`composeTitle()`).
13. **Never put pure logic inside a `"use server"` module.** Those files import next-auth, which
    cannot load under Vitest, so anything defined there is untestable. Extract it to a plain module
    and import it back — `server/agents/merchant/variants.ts` is the pattern.
14. **`payments.gateway` must name the gateway that SETTLED, not the one that opened the
    checkout.** `authorizeCheckout()` writes the configured gateway; `confirmPayment()` may settle
    through a different one passed explicitly (saved-method purchases pass `MockGateway` while
    `PAYMENT_GATEWAY=razorpay`). Refunds resolve the gateway from this column, so the capture
    update rewrites it. Seeded payments are labelled `mock` because their ids are fabricated and
    do not exist at Razorpay.
15. **`slugFragment` truncates each option to 4 characters**, so "Large" and "Larger" both yield
    `LARG`. SKUs must be reserved **sequentially** with a local reserved-set; generating a batch
    concurrently lets two variants agree on a base neither has inserted yet, and
    `variants_sku_idx` then rejects the insert.
16. **Interpolating a column into a `` sql`` `` template renders it UNQUALIFIED.**
    `` sql`... WHERE ${orderItems.orderId} = ${orders.id}` `` becomes
    `WHERE "order_id" = "id"`, and inside a correlated subquery Postgres binds both names to the
    INNER table — `order_items.order_id = order_items.id`, always false. It does not error; it
    silently returns 0 / NULL. The merchant orders page showed "0 units" and a blank product title
    on every row this way, and an `EXISTS` written the same way silently hid the Refund control.
    **In a correlated subquery, alias the inner table and name the outer one in full:**
    `` sql`(SELECT ... FROM ${orderItems} AS oi WHERE oi.order_id = orders.id)` ``.
    Interpolating a *value* (`${sessionId}`) is safe and unaffected — it becomes a bind parameter.
17. **A gateway order can cover several payments.** Group checkout settles N orders against one
    gateway order, so any lookup by `gatewayOrderId` must handle a LIST — taking the first row
    leaves every other merchant's order stuck in `pending_payment` while the money has moved.
18. **Groq's free tier caps tokens PER DAY PER MODEL** (200k on `gpt-oss-120b`), and reasoning
    models burn them fast. `GROQ_FAST_MODEL` (default `openai/gpt-oss-20b`) serves the
    `parse_intent` task, which fires on every conversational turn — fewer tokens *and* a separate
    daily pool, so one exhausted model no longer takes the whole agent down. A 429 surfaces as
    `provider: "deterministic-fallback"`; `LlmResult.attempts` carries the real reason.
19. **Validate model output leniently — TRUNCATE, do not reject.** A hard `z.string().max(120)`
    threw away an entire good understanding because the model wrote a chatty `productType`, and the
    turn silently fell back to pattern matching with no error anywhere. Caps on model text are
    sanity bounds, not correctness requirements.
20. **Do not detect intent by enumerating a domain.** The fallback decided "purpose is known" from
    a list of sports, so it asked "what will you use them for?" at someone who had said *tennis
    shoes* — and would have done the same for badminton, squash and golf. `hasStatedPurpose()`
    instead strips filler and the product noun and asks whether ANYTHING is left. Prefer a rule
    about the shape of the sentence over a list of the words you thought of.
21. **An eval set with SAMPLED ground truth measures nothing.** Capping expected results at 40 rows
    made retrieval look broken: 178 products qualify as breathable, so returning ten genuinely
    breathable shoes scored zero when none fell in the arbitrary 40. Overall recall read 0.569; with
    complete ground truth the same index scored 0.722. A wrong harness is worse than none — it
    sends you optimising against noise.
22. **Shared phrasing across documents compresses the embedding space.** Rendering quality scores
    into every product's text doubled attribute recall (0.295 -> 0.629) but made two UNRELATED
    documents 27% more similar (0.186 -> 0.237), which narrowed the relevance gate's margin. Both
    effects are real; the trade was taken deliberately. Watch for it whenever boilerplate is added
    to every document.
23. **`MIN_TOP_RELEVANCE` is measured, never chosen.** `npm run eval:relevance-gate` re-measures the
    two bands. Growing the catalogue 184 -> 503 lifted the unstocked ceiling from 0.307 to 0.375,
    because a marketplace that sells kitchen appliances IS nearer to "washing machine". Re-measure
    after any material catalogue change; never raise it to block a query, because that starts
    refusing products you actually sell ("noise cancelling headphones" sits at 0.373).
24. **A min-max normalised criterion cannot carry a fixed threshold.** A relevance gate keyed off
    `criteria.normalized` looked right on a 60-candidate search and cut the entire result set on a
    small one: normalisation is min-max across the survivors, so with two candidates the runner-up
    is 0 BY CONSTRUCTION however close it really was. Thresholds belong on raw scores.
25. **RRF scores are rank-based and decay steeply, so ratios of them are a blunt instrument.**
    Measured on "black running shoes for daily road training": top 1.00, then genuinely relevant
    running shoes at 0.43, 0.39, 0.33, a walking shoe at 0.29 and a sandal at 0.27. Any ratio strict
    enough to exclude an off-topic item also excludes legitimate ones. A relevance gate built this
    way was tried, measured and REMOVED — the fix for off-topic results was making the lexical leg
    work, not post-filtering the ranking.

26. **Boilerplate in a chunk is what the embedding learns.** Evidence chunks were built as
    `"Review of <product> (<category>) — <n> out of 5. <title> <body>"`. On a two-line review that
    prefix is half the tokens, so the vector encoded the template every chunk shares instead of the
    sentence that distinguishes it — §8.23 with the volume turned up. It failed exactly as you would
    predict: "my feet get unbearably hot on long runs" retrieved THERMAL RUNNING TIGHTS at 0.643.
    The chunk is now the opinion and nothing else; `productId`, `merchantId` and `ratingBp` are
    COLUMNS and can be filtered, joined and displayed without being embedded, which is the reason
    the evidence lives in its own table at all.
27. **A generated corpus can contradict itself, and 41% of this one did.** `titleFor` took its
    sentiment from the reviewer's OVERALL stars while the body took its from each quality's own
    score. Those disagree precisely when a product is good at one thing and bad overall — a shoe
    scoring breathability 4 and durability 1 rates ~2.5 stars, and was titled "Breathability is the
    weak spot" above a body praising the airflow. 1,654 of 4,008 reviews were affected. It was
    invisible while nothing read the corpus and glaring the moment review text was quoted to
    shoppers. `npm run db:fix-review-titles` repairs headlines surgically rather than regenerating
    bodies and ratings. **Whenever generated text and generated numbers describe the same thing,
    assert they agree** — §6 says a self-contradicting dataset is worse than none, and this is how
    one gets in.
28. **A backtick inside a `` sql`` `` template comment terminates the template.** Writing
    "the `vec` and `lex` legs" in a SQL comment inside a tagged template ends the string, and the
    error surfaces as `TS1005: ',' expected` pointing at prose — nowhere near a real syntax problem.

29. **The image service admits roughly ONE anonymous request in flight.** Measured: 3 concurrent
    returned two 429s, 6 returned five. There is no throughput to win by parallelising — raising
    concurrency earns rate-limit errors, not images. What makes a long run finish is **retrying**,
    because a 429 means "in a moment" and the old code treated it exactly like a permanent failure:
    a batch of forty produced three images and thirty-seven phantom failures, which is why this
    looked for weeks like a broken image pipeline rather than a missing retry. Retryable is
    429/408/5xx/timeout; a 400 will fail identically forever and must not burn the budget. At ~40s
    an image the full catalogue is a many-hour job, so pairs are photographed **most-sold first** and
    every run is resumable (`image_url IS NULL`).
30. **Never run `npm run build` while `npm run dev` is running** — they share `.next`, and the build
    reads chunks the dev server is rewriting. It fails with a DIFFERENT error each time
    (`Failed to collect page data`, `TypeError: a[d] is not a function` in webpack-runtime) on
    whichever route lost the race, which reads as a real bug in that route. Kill dev, `rm -rf .next`,
    then build.

31. **A client component importing a value from a module that imports `db` breaks the build.**
    `browse-filters.tsx` ("use client") imported `BROWSE_SORTS` from `server/catalog/browse.ts`,
    which dragged the `postgres` driver into the browser bundle:
    `Module not found: Can't resolve 'net'` — and because it is a compile error, it 500s every
    route, not just the new one. `import type` alone is erased and would have been safe; importing
    a VALUE is what pulls the module graph across. Same rule as #14: what both sides share lives in
    a module that imports neither side's machinery (`src/lib/browse.ts`).
32. **A heading over an empty chart reads as a rendering failure.** Chart components that return
    `null` for an empty set must take the label with them — otherwise the section title survives
    over blank space and looks broken.

33. **Tests that name a specific product are brittle at scale.** Two search tests pinned
    "Velocity Run 3" in the top 10 of a generic query. That held at 184 products; at 503 the ten
    returned depend on stock levels other suites legitimately mutate, so they passed alone and
    failed in the suite. Assert the PROPERTY (results are relevant; a named product is retrievable
    when named) rather than a specific winner.



34. **A model that answers confidently but wrongly is worse than one that fails.** `refine.ts` did
    `want = value`, replacing the rule extraction wholesale — so when the model returned
    `color: null` for a sentence plainly saying "volt", the rules' correct reading was discarded and
    the turn fell through to a catch-all, with `degraded: false` and no error anywhere. Rules are a
    SAFETY NET over the model, not merely a substitute when it is offline: back-fill the fields the
    model left null, and let a value it actually stated win. Same shape as §8.8.
35. **A question about the CONTAINER is not a question about the CONTENT.** "What are some of the
    reviews?" cannot be served by retrieval over reviews — they discuss the product, not themselves —
    and it scores 0.311 where "is it comfortable" scores 0.553, so the relevance floor rejects it
    correctly and the reviews stay unreachable. Recognise the shape and return a SAMPLE. Watch for
    this wherever RAG is wired: asking FOR the evidence is a different request from asking something
    the evidence answers.

---

## 9. Configuration

`.env.local` (git-ignored via `.env*`; **never commit secrets**):

```
DATABASE_URL, AUTH_SECRET, PLATFORM_URL
LLM_PRIMARY=groq, GROQ_MODEL=openai/gpt-oss-120b, GROQ_API_KEY
GEMINI_API_KEY, OPENROUTER_API_KEY, CEREBRAS_API_KEY   (optional failover)
# OLLAMA_BASE_URL  — leave UNSET; setting it runs a local model
EMBEDDING_PROVIDER=local, EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
PAYMENT_GATEWAY=razorpay|mock, RAZORPAY_KEY_ID (rzp_test_*), RAZORPAY_KEY_SECRET,
RAZORPAY_WEBHOOK_SECRET
STORAGE_DRIVER=local|supabase, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET
```

Setup: `createdb agentic_commerce` → `CREATE EXTENSION vector; CREATE EXTENSION pgcrypto;` →
`npm run db:migrate` → `npm run db:seed` → `npm run db:seed-extra` → `npm run catalog:index` →
`npm run catalog:images` → `npm run doctor`.

**The app runs with no API keys at all** via deterministic fallbacks — degraded in quality, never
in function. Preserve that property.

## 10. Commands

| | |
|---|---|
| `npm run doctor` | preflight: DB, pgvector, seed, index, embeddings, LLM, Razorpay |
| `npm run db:seed` | **DESTRUCTIVE** — truncates every table |
| `npm run db:seed-extra` | additive, idempotent, preserves real users |
| `npm run catalog:index [-- --force]` | rebuild AI catalog + embeddings |
| `npm run catalog:images` | generate missing product images |
| `npm run catalog:variant-images [-- --limit N --gender men]` | per-colour images, most-sold first, resumable |
| `npm run mcp:stdio` | MCP server for an MCP desktop client |
| `npm test` | full suite (integration, needs the DB seeded) |

Demo logins: `demo@shopper.test` / `care@stride.test`, password `demo1234`.
Razorpay test card: **4100 2800 0000 1007** (`4111 1111 1111 1111` is international and declines).
