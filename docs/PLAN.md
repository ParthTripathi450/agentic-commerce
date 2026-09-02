# Agentic Commerce Platform — Build Plan

A multi-merchant, AI-native marketplace where merchants publish machine-readable catalogs and
AI agents search, compare, explain, obtain authorization, and transact — with every AI and
financial action explainable, bounded, gated and audited.

Built entirely on free tiers with **no credit card required anywhere**.

---

## 0. The one architectural decision that drives everything

**The LLM is not the search engine, the ranker, or the executor. It is the interpreter and the narrator.**

```
NL query ──LLM──> structured intent ──Postgres(pgvector+FTS+filters)──> candidates
                                     ──deterministic scorer──────────> ranked + scored
                                     ──LLM──> explanation grounded in the real scores
                                     ──policy engine──> ALLOW | REQUIRE_APPROVAL | DENY
                                     ──mandate chain──> payment
```

Why this shape:
- **Free-tier survivable.** Free LLM APIs are rate-limited (Groq ~30 RPM / 14.4k RPD). An agent
  that "thinks" its way through retrieval burns the quota in minutes. Two LLM calls per shopping
  turn (parse + explain) does not.
- **Honest explanations.** The "why this product" text is generated *from* the actual scoring
  vector, so it cannot invent reasons the ranker didn't use.
- **Testable.** Ranking, policy checks, mandate verification and failure paths are pure functions
  with unit tests. Only taste-based output is stochastic.
- **Reproducible.** Same query + same catalog = same ranking, every time.

---

## 1. Stack (all free, no card)

| Layer | Choice | Why / free-tier note |
|---|---|---|
| App | Next.js 15 App Router + TypeScript + Tailwind + shadcn/ui | One app serves UI + MCP/UCP/ACP endpoints. Vercel free tier, no card. |
| DB | Postgres + pgvector, via **Drizzle ORM** | Drizzle keeps us on plain SQL — runs identically on Supabase free (500MB, pgvector, no card) or local Postgres. No lock-in. |
| Auth | **Auth.js v5**, credentials + bcrypt, roles in our own table | Zero external dependency, no signup, works offline. Roles: `customer` \| `merchant` \| `admin`. |
| Embeddings | **`@huggingface/transformers`** running `all-MiniLM-L6-v2` (384-dim) in Node | Local CPU inference. No API key, no card, no rate limit. 22M-parameter model (96MB on disk), **measured on this M1: 255ms cold start, 4ms per query, 122ms to re-embed the whole catalog.** Not an LLM — roughly spellchecker-class compute. |
| LLM | Provider abstraction over **Groq / Gemini (AI Studio) / OpenRouter / Cerebras**, all remote | All have real no-card free tiers. Automatic failover + cache + rate-limit queue. Deterministic rule-based fallbacks make the whole app runnable and testable with **no key at all**. Ollama (local inference) exists as a provider but is **opt-in only** — it activates solely when `OLLAMA_BASE_URL` is explicitly set, so no LLM ever runs on the developer machine by accident. |
| Payments | **Razorpay test mode** (`rzp_test_`) behind a `PaymentGateway` interface, with a **mock gateway** as the default | Razorpay test keys need only an email signup, no KYC, no card. Mock gateway means the full purchase flow is demoable before any signup. |
| Signing | `jose` (ES256 JWS) for AP2 mandates | — |
| MCP | `@modelcontextprotocol/sdk` — stdio + Streamable HTTP | stdio transport lets MCP desktop clients shop the marketplace directly. |
| Charts | Recharts | — |
| Tests | Vitest | Covers scorer, policy engine, mandate chain, failure paths. |

**Risk register**
- Free LLM rate limits → provider failover chain, response cache, minimal LLM calls per turn, `mock` provider.
- Supabase free projects pause after 7 idle days, 500MB cap → fine for demo; local Postgres is a drop-in via `DATABASE_URL`.
- No Razorpay keys yet → mock gateway is the default; real test keys are an env flip.

---

## 2. Data model (Postgres)

```
users(id, email, password_hash, role, name)
merchants(id, user_id, slug, name, description, keypair_id, status, policies_json)
products(id, merchant_id, title, description, category, brand, attributes_json, status)
product_variants(id, product_id, sku, attributes_json{size,color,...}, price_minor, currency, compare_at_price)
inventory(variant_id, quantity, reserved, low_stock_threshold, restock_eta)
availability_windows(variant_id, starts_at, ends_at)          -- "availability"
merchant_policies(merchant_id, returns, shipping, warranty, cancellation)
promotions(id, merchant_id, type, value, conditions_json, active_from, active_to)

catalog_documents(product_id, ai_text, embedding vector(384), tsv tsvector, updated_at)

carts(id, user_id, status) / cart_items(cart_id, variant_id, qty, unit_price_minor)
checkout_sessions(id, cart_id, merchant_id, state, totals_json, idempotency_key)
orders(id, user_id, merchant_id, state, totals_json) / order_items(...)
payments(id, order_id, gateway, gateway_order_id, gateway_payment_id, amount_minor, state, raw_json)

agent_sessions(id, user_id, kind{customer,merchant}, state)
agent_events(id, session_id, step, observation_json, reasoning_json, action_json, outcome_json, model, tokens, latency_ms)
mandates(id, type{intent,cart,payment}, subject_id, parent_mandate_id, payload_json, jws, expires_at, status)
agent_policies(scope{user,merchant}, scope_id, limits_json)
approvals(id, session_id, action_json, status, decided_by, decided_at, reason)

insights(id, merchant_id, kind, severity, evidence_json, recommendation_json, status)
webhook_events(id, source, payload_json, signature_valid, processed_at)
```

---

## 3. Explainability: one record shape for both agents

Every consequential step writes an `agent_events` row:

```jsonc
{
  "step": "RANK",
  "observation": { "query": {...}, "candidates_considered": 47, "sources": ["merchant:acme","merchant:zip"] },
  "reasoning": {
    "criteria": [ { "name":"price_fit", "weight":0.30, "value":4299, "normalized":0.86, "contribution":0.258 }, ... ],
    "tradeoffs": "Cheaper option existed but failed the size-10 constraint",
    "rejected_alternatives": [ { "product":"...", "reason":"out of stock in size 10" } ]
  },
  "action":  { "type":"propose_product", "bounds_checked":["max_order_value"], "requires_approval":false },
  "outcome": { "status":"ok", "latency_ms":412, "model":"groq/llama-3.3-70b", "tokens":890 }
}
```

The audit-trail UI is a timeline over this table — it satisfies "what the agent observed, decided
and executed" for both the customer and merchant sides with one abstraction.

---

## 4. Guardrails: one policy engine

`evaluate(action, context) -> { verdict: ALLOW | REQUIRE_APPROVAL | DENY, reason, bounds_checked[] }`
called before **every** money-moving or catalog-mutating action.

- **Customer limits:** max order value, max daily spend, max items/order, currency, merchant
  allow/deny list, `require_approval_above` threshold. Payment *always* requires explicit consent.
- **Merchant-agent limits:** max price change %, max discount %, max restock quantity/cost,
  auto-publish allowed?, approval required (default **true**).

Both `DENY` and `REQUIRE_APPROVAL` are written to the audit trail with their reason — a refused
action is as visible as a completed one.

---

## 5. Protocol surfaces

### UCP (Google/Shopify, announced NRF Jan 2026)
- `GET /api/ucp/{merchant}/.well-known/ucp` → capability manifest: `services` (`dev.ucp.shopping` →
  REST endpoint + OpenAPI), `capabilities[]` (name, version, schema), `payment_handlers[]`, and the
  merchant's **public key** so agents can verify Cart Mandates.
- `POST /checkout-sessions`, `PUT /checkout-sessions/{id}`, `POST /checkout-sessions/{id}/complete`,
  honoring `UCP-Agent`, `Idempotency-Key`, `Request-Id`, `Request-Signature` headers.

### ACP (OpenAI/Stripe)
- `GET /api/acp/{merchant}/feed.json` (+ `.csv`) — the **AI-readable catalog**, emitted in ACP
  Product Feed field names (`id`, `item_group_id`, `title`, `description`, `link`, `image_link`,
  `price`, `availability`, `inventory_quantity`, `color`, `size`, `condition`, `shipping`,
  `return_policy`, …).
- This is the elegant part: **merchant dashboard input → one normalizer → ACP feed + UCP manifest +
  embeddings, all regenerated automatically.** Merchants never author "AI catalog" content by hand.

### MCP
Tools exposed over **stdio** (a desktop client can shop the marketplace) and **Streamable HTTP** at
`/api/mcp` (our own web agent):
`search_products` · `get_product` · `check_availability` · `compare_products` ·
`get_merchant_policies` · `list_capabilities` · `create_cart` · `create_checkout_session` ·
`request_payment_authorization` · `get_order_status`

### AP2 (Google) — the authorization chain
1. **IntentMandate** — signed when the user states a goal. Natural-language intent + constraints
   (max price, currency, required attributes, allowed merchants) + expiry.
2. **CartMandate** — exact cart, per-item prices, totals, merchant. Signed by the **merchant** key
   (attesting the price is real), countersigned by the **user** on approval.
3. **PaymentMandate** — references the cart mandate hash, amount cap, method. Signed by the user.

Before charging: verify `payment → cart → intent`, check the cart satisfies the intent's
constraints, check expiries and policy bounds. Any mismatch → refuse and log.
*Demo value: tamper a cart price and watch chain verification reject the payment.*

> Demo simplification, documented honestly in the README: keys are held server-side per
> user/merchant rather than on a user device.

### x402 (optional, last phase)
`GET /api/x402/insights/{merchant}` returns **HTTP 402** with payment requirements, accepts an
`X-PAYMENT` header, verified by a **mock facilitator** by default (no wallet, no funds, no card),
with the Base Sepolia testnet path documented but not required.

---

## 6. Agent runtimes

### Customer agent — a state machine, not a free-form loop
`UNDERSTAND → SEARCH → RANK → EXPLAIN → SELECT → CART(+CartMandate) → AUTHORIZE(human) → PAY → CONFIRM`

Each state has an allowed tool set. No runaway loops, bounded tokens, every transition audited.

- **UNDERSTAND** (LLM): "black running shoes, size 10, under ₹5,000" → `{category, attributes:{color:black,size:10}, price_max:500000, currency:INR}`
- **SEARCH** (no LLM): hybrid retrieval across *all* merchants — pgvector cosine + Postgres FTS,
  merged by Reciprocal Rank Fusion, then hard structured filters (price, variant attrs, in-stock,
  availability window, merchant policy).
- **RANK** (no LLM): deterministic weighted scorer — constraint fit, price fit, availability,
  merchant reliability, rating, delivery, return policy. Publishes per-criterion contributions.
- **EXPLAIN** (LLM): narrates the score vector — why this one, and why it beats each runner-up.
- **AUTHORIZE**: explicit human consent UI showing exact amount, merchant, items, and the bounds
  being applied. No money moves without it.

**Failure handling, defined per state:** no results → relax constraints and *say which*; out of
stock at cart time → offer ranked alternatives; limit exceeded → explain the specific bound and
offer to request a raise; payment failed → surface the gateway reason, offer retry with the **same
idempotency key** (never a silent re-charge).

### Merchant agent
Runs over materialized analytics, emits `insights` rows carrying evidence + recommendation +
projected impact, e.g. *"Restock SKU-4471: 6 units left, 30-day velocity 2.1/day, stockout in ~3
days, ₹18,400 revenue at risk."* Every recommendation is a **proposed action** → policy engine →
approval queue → bounded execution. It can explain any recommendation on demand by replaying its
evidence.

---

## 7. Build phases

| Phase | Deliverable |
|---|---|
| **P0 Foundations** | Scaffold, Drizzle schema + migrations, Auth.js with roles, merchant/customer shells, seed script (~6 merchants × ~120 products with variants + 90 days of synthetic orders — analytics and insights need real history to be credible) |
| **P1 Merchant dashboard** | Products, variants, pricing, inventory, availability, policies, promotions, orders — full CRUD |
| **P2 AI-readable catalog** | Normalizer → `ai_text`, embeddings pipeline, ACP feed endpoints, UCP `.well-known` manifest, merchant keypairs |
| **P3 MCP server** | Catalog + commerce tools, stdio + HTTP transports, desktop client config |
| **P4 Customer agent** | LLM provider abstraction + failover + cache, intent parser, hybrid retrieval, deterministic ranker, explanation layer, chat UI with comparison cards |
| **P5 Commerce + AP2 + Razorpay** | Cart, UCP checkout sessions, mandate chain + verification, authorization UI, payment adapter (mock ‖ Razorpay test), webhook verification, orders |
| **P6 Merchant analytics + insights** | Revenue by day/month/year, orders, best sellers, trends, inventory levels, low-stock/stockout alerts, insights agent, approval queue, bounded execution |
| **P7 Governance** | Limits UI, audit-trail timeline UI, failure-path hardening, Vitest suite over scorer / policy engine / mandate chain |
| **P8 Optional** | x402 endpoint, deploy, README, demo script |

---

## 8. What "done" looks like

A customer types *"Find me black running shoes, size 10, under ₹5,000"*, the agent searches six
merchants' machine-readable catalogs, returns a ranked comparison with a per-criterion explanation
of why #1 beat #2, builds a cart under a signed mandate chain, asks for explicit authorization
showing the exact amount and the limits in force, charges via Razorpay test mode, and leaves a
complete audit trail — while the merchant sees the order land, their stock drop, and their agent
raise a restock recommendation with the evidence behind it.

---

# Build status — 2026-09-01

**43 tests passing · clean lint · production build succeeds (24 routes).**

## Complete

| Phase | State | Notes |
|---|---|---|
| **P0 Foundations** | done | 26-table schema, pgvector, Auth.js roles, seed (6 merchants / 39 products / 247 variants / 713 orders) |
| **P1 Merchant dashboard** | done | Analytics overview, products list + editor, orders, protocols page |
| **P2 AI-readable catalog** | done | Normalizer → embeddings + ACP feed; re-indexes automatically on every save |
| **P3 MCP server** | done | 6 tools, stdio + Streamable HTTP, verified over real JSON-RPC |
| **P4 Customer agent** | done | UNDERSTAND → SEARCH → RANK → EXPLAIN, provider failover, relevance gate |
| **P5 Commerce + AP2 + Razorpay** | done | Mandate chain with tamper detection, real Razorpay test-mode payments |
| **P6 Merchant insights** | done | Detectors + grounded explanations + approval-gated execution |
| **P7 Governance** | done | Policy engine, limits UI, append-only audit trail UI |
| **P8 x402** | done | HTTP 402 challenge + signed retry, mock facilitator (no wallet or funds needed); Base Sepolia is a facilitator swap |

## Decisions that changed during the build

- **Groq model pinned to `openai/gpt-oss-120b`** — `llama-3.3-70b-versatile` was decommissioned
  mid-build. `npm run doctor` now verifies model availability so the next rotation fails loudly.
- **Reasoning models need a bigger token budget.** `gpt-oss` spent its whole 320-token budget
  thinking and returned empty; explanations now allow 1200 tokens at `reasoning_effort: low`.
- **A budget ceiling is a constraint, not a priority.** "under ₹5,000" was being read as
  "prioritise cheapest", which demoted a better-supported product.
- **Relevance is a gate, not a weighted criterion.** A ₹999 t-shirt outranked headphones because
  relevance was merely one weight among seven. Candidates below 55% of the top semantic score are
  now excluded with a stated reason.
- **Ratings are confidence-adjusted.** Raw averages let a 5.0 from 3 reviews beat a 4.6 from 900.
  Bayesian shrinkage toward the catalog mean; rating weight raised 0.06 → 0.20 (0.30 for
  "best quality").
- **Platform spend ceiling raised to ₹50,000/order.** The original ₹5,000 blocked a ₹4,299 shoe
  once GST was added. The real guard is `requireApprovalAboveMinor: 0` — every payment needs
  explicit consent.
- **Selecting an option replaces the cart** rather than appending, after appending silently turned
  a ₹4,299 purchase into a ₹20,291 one.
- **Ollama is opt-in only.** It was reachable by default in the failover chain, which would have
  run a multi-GB model on the developer's machine unasked.

## Known gaps

All spec clauses are now implemented. Remaining items are operational, not functional:

- **Not deployed.** Runs against local Postgres. `README.md` carries the Supabase + Vercel steps;
  storage and webhooks both need the deployed origin to be exercised for real.
- **Refunds** are not implemented — a cancelled paid order returns stock and tells the merchant to
  refund in the Razorpay dashboard.
- `/merchant` ships ~110 kB of JS (Recharts).

## Closed after the spec audit (2026-09-01)

| Gap | Resolution |
|---|---|
| Could not create products or variants | `/merchant/products/new` plus add/withdraw variant; a product is always created with its first variant, since one without a variant has no price and is invisible to agents |
| Policies not editable | `/merchant/settings`; saving re-indexes the whole catalog, because return window and delivery time are **scored ranking criteria**, not decoration |
| Availability windows unmanageable | Per-variant sale window; search already enforced it live |
| Agent could not adjust availability | New detector for listings that are unbuyable but still listed, with a policy-gated executor that withdraws them and re-indexes |
| No webhook handler | `/api/webhooks/razorpay` — fails closed on bad signatures, idempotent on event id, never un-pays a paid order, releases stock on failure |
| No order fulfilment | Mark delivered / cancel, with stock returned on cancelling a paid order |
| No image storage | Driver interface with local-disk and Supabase Storage implementations; uploads validated by **magic bytes**, not the declared MIME type |
| Merchant agent limits not editable | Now on `/merchant/settings` |
| No promotions UI | `/merchant/promotions`; merchant-authored discounts are deliberately not bound by the *agent's* limits |
