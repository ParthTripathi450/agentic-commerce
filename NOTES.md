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
      shop, cart, checkout, orders, support, activity, settings/limits
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
                            autonomous.ts, dto.ts
    agents/merchant/        agent.ts (insights), detectors.ts,
                            product-assistant.ts, listing-actions.ts
    catalog/                search.ts, indexer.ts, normalize.ts, vocabulary.ts,
                            featured.ts, actions.ts, image-actions.ts,
                            create-product.ts (THE single writer), attributes.ts
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

## 5. Data model (31 tables)

Core: `users, accounts, sessions, verification_tokens, signing_keys`
Merchant: `merchants, merchant_policies, promotions`
Catalog: `products, product_variants, inventory, availability_windows, catalog_documents`
Commerce: `carts, cart_items, checkout_sessions, orders, order_items, payments, webhook_events`
Agent/governance: `agent_sessions, agent_events, mandates, agent_policies, approvals, insights`
Social: `product_reviews, merchant_reviews, support_threads, support_messages`
Payment: `payment_methods`

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
13. **Every LLM path has a deterministic fallback, and the fallback is a *normal* path, not an
    edge case** — Groq rate-limits regularly, and `buildFallbackDraft()` is then what the merchant
    actually sees. A change to the model path that is not mirrored in the fallback is a bug:
    that is precisely how the wizard shipped *"Nike Nike Air Zoom Pegasus"*. Shared logic belongs
    in a helper both call (`composeTitle()`).
14. **Never put pure logic inside a `"use server"` module.** Those files import next-auth, which
    cannot load under Vitest, so anything defined there is untestable. Extract it to a plain module
    and import it back — `server/agents/merchant/variants.ts` is the pattern.
15. **`payments.gateway` must name the gateway that SETTLED, not the one that opened the
    checkout.** `authorizeCheckout()` writes the configured gateway; `confirmPayment()` may settle
    through a different one passed explicitly (saved-method purchases pass `MockGateway` while
    `PAYMENT_GATEWAY=razorpay`). Refunds resolve the gateway from this column, so the capture
    update rewrites it. Seeded payments are labelled `mock` because their ids are fabricated and
    do not exist at Razorpay.
16. **`slugFragment` truncates each option to 4 characters**, so "Large" and "Larger" both yield
    `LARG`. SKUs must be reserved **sequentially** with a local reserved-set; generating a batch
    concurrently lets two variants agree on a base neither has inserted yet, and
    `variants_sku_idx` then rejects the insert.
17. **Interpolating a column into a `` sql`` `` template renders it UNQUALIFIED.**
    `` sql`... WHERE ${orderItems.orderId} = ${orders.id}` `` becomes
    `WHERE "order_id" = "id"`, and inside a correlated subquery Postgres binds both names to the
    INNER table — `order_items.order_id = order_items.id`, always false. It does not error; it
    silently returns 0 / NULL. The merchant orders page showed "0 units" and a blank product title
    on every row this way, and an `EXISTS` written the same way silently hid the Refund control.
    **In a correlated subquery, alias the inner table and name the outer one in full:**
    `` sql`(SELECT ... FROM ${orderItems} AS oi WHERE oi.order_id = orders.id)` ``.
    Interpolating a *value* (`${sessionId}`) is safe and unaffected — it becomes a bind parameter.
18. **A gateway order can cover several payments.** Group checkout settles N orders against one
    gateway order, so any lookup by `gatewayOrderId` must handle a LIST — taking the first row
    leaves every other merchant's order stuck in `pending_payment` while the money has moved.
19. **Groq's free tier caps tokens PER DAY PER MODEL** (200k on `gpt-oss-120b`), and reasoning
    models burn them fast. `GROQ_FAST_MODEL` (default `openai/gpt-oss-20b`) serves the
    `parse_intent` task, which fires on every conversational turn — fewer tokens *and* a separate
    daily pool, so one exhausted model no longer takes the whole agent down. A 429 surfaces as
    `provider: "deterministic-fallback"`; `LlmResult.attempts` carries the real reason.
20. **Validate model output leniently — TRUNCATE, do not reject.** A hard `z.string().max(120)`
    threw away an entire good understanding because the model wrote a chatty `productType`, and the
    turn silently fell back to pattern matching with no error anywhere. Caps on model text are
    sanity bounds, not correctness requirements.



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
| `npm run mcp:stdio` | MCP server for an MCP desktop client |
| `npm test` | full suite (integration, needs the DB seeded) |

Demo logins: `demo@shopper.test` / `care@stride.test`, password `demo1234`.
Razorpay test card: **4100 2800 0000 1007** (`4111 1111 1111 1111` is international and declines).
