# PROGRESS.md — current state

Read `NOTES.md` first for architecture and conventions. This file is the state snapshot.

**Last updated:** 2026-09-02
**Health:** 114 tests passing (18 files) · 0 lint issues · production build clean ·
34 route files · 31 tables
**Git:** pushed to `origin/main`
**Repo:** https://github.com/ParthTripathi450/agentic-commerce-platform (private)

**Local data:** 13 merchants · 68 active products · 340 variants · 27 categories · 910 orders ·
24 users · 68/68 indexed · **68/68 have images**

---

## 1. Complete and verified

### Customer side
- **Assisted shopping** (`/shop`): UNDERSTAND → SEARCH → RANK → EXPLAIN state machine
  (`server/agents/customer/agent.ts`). Reference query returns the ₹4,299 Velocity Run 3 with a
  grounded explanation and the ruled-out alternatives.
- **Autonomous mode** ("Let the agent buy it for me"): agent selects, signs mandates, builds the
  cart, stops at ONE allow/deny screen showing reasons + runners-up #2/#3.
  Verified over HTTP: `orders before 903 → after 903` (nothing created before approval).
- **Cart**: per-merchant carts, quantity steppers bounded by live stock, `/cart` + `/checkout`,
  nav badge. Verified: 3 units added, total ₹15,218.46.
- **Quantity clarification**: "a few yoga mats" → *"You mentioned more than one but not how many."*
  A plain "a yoga mat" is not interrogated.
- **Orders**: product reviews + merchant service reviews, both gated on a real purchase.
- **Support**: threads routed to the merchant who sold the item; merchant inbox at
  `/merchant/support`.
- **Activity**: append-only audit timeline with scoring breakdowns and refusals.
- **Spending limits** + **saved test payment method** at `/settings/limits`.

### Merchant side
- **Dashboard** (`/merchant`): "Welcome back", sparkline stat tiles, revenue chart (30d/12m/5y),
  best sellers, category mix, urgency-ranked inventory alerts, declining-demand list.
- **Products**: list with search, full editor (title/description/specs/status), variant
  price/stock/threshold/withdraw, availability windows, image upload.
- **Listing wizard** (`/merchant/products/new`): item → brand → product → auto-fetched
  specs + tags. Manual fallback at every step. Provenance labelled (marketplace vs suggested).
- **Search tags**: own column, tsvector weight **A** vs description **B**.
  Measured: same term ranks **0.6079 as a tag vs 0.2432 in body** (2.5×). Editable + regenerable.
- **Insights agent**: 6 detectors (stockout, stockout risk, overstock, demand drop, catalog
  quality, stale-unavailable), each with evidence, projected impact and confidence.
  Policy-gated, approval-queued, bounded execution.
- **Orders**: mark delivered / cancel (returns stock).
- **Promotions**, **store settings** (profile, policies, agent limits), **protocols** page.

### Platform
- **Protocols**: MCP (stdio + HTTP, 6 tools), UCP manifest + `.well-known`, ACP feed (JSON/CSV),
  AP2 mandate chain, x402 paid endpoint. All verified live.
- **Payments**: Razorpay test mode verified (real test order `order_TWhEgFJlDFGflB`), forged
  signatures refused, webhooks idempotent and fail-closed, saved-method settles server-side.
- **Governance**: policy engine, human authorization before any charge, append-only audit.

---

## 2. Known gaps and issues

| # | Issue | Notes |
|---|---|---|
| 1 | ~~Listing wizard not exercised end-to-end~~ **CLOSED** | The user created two products through it: *Ultraboost Running Shoes* (18 variants / 18 inventory rows / 360 units) and *Nike Air Zoom Pegasus* (1 / 1 / 10). Both indexed with `tags_text` populated. Pure logic now covered by `listing.test.ts` (13 tests). |
| 2 | **Not deployed** | Runs on local Postgres. `README.md` has the Supabase + Vercel steps. Storage (`STORAGE_DRIVER=supabase`) and webhooks both need a public origin. |
| 3 | ~~One product image missing~~ **CLOSED** | 68/68. `npm run catalog:images` generated the 3 outstanding ones. |
| 4 | **Refunds not implemented** | Cancelling a paid order returns stock and tells the merchant to refund in the Razorpay dashboard. |
| 5 | **Saved card ≠ Razorpay rails** | Razorpay test mode cannot charge a stored card server-side without real tokenisation. Saved-method purchases settle through `MockGateway`. The UI states this. Intentional, not a bug. |
| 6 | **`/merchant` ships ~110 kB JS** | Recharts. Fine, but the obvious thing to trim. |
| 7 | **Multi-merchant checkout is sequential** | Carts are per-merchant by design (checkout, Cart Mandate and fulfilment all are). A shopper with 3 merchants checks out 3 times. |
| 8 | **Product creation has two paths** | `NewProductForm` (manual) and `ListingWizard` (assisted) use different actions (`createProductAction` vs `createAssistedProductAction`). Only the manual one predates this session. Consider consolidating. |
| 9 | **`MAX_VARIANTS = 24`** | The wizard refuses larger cartesian products and asks the merchant to trim. Covered by tests; the user's 18-variant product passed under the cap, so the *refusal* path is still untested by hand. |

---

## 3. Changes in the previous session

1. **GitHub repo created and pushed** (private). Verified `.env.local`/`node_modules` excluded and
   scanned staged content for the Razorpay/Groq keys before the first push.
2. **Saved-method payment fixed** — it was falling back to the Razorpay widget because
   `PAYMENT_GATEWAY=razorpay`. First attempt mutated `process.env`, which is a **race** in a
   concurrent server; replaced with an explicit `gateway` parameter on `confirmPayment()`.
3. **Cart + quantity** added (schema already supported multi-item carts; UI did not).
4. **Quantity ambiguity** — `quantityStated` flag; `quantity: 0` from the model means "unstated"
   and is normalised to 1 with `quantityStated: false`. Schema had to allow 0 (it was `min(1)`,
   which rejected the model doing exactly what it was told).
5. **Relevance guard corrected twice**:
   - now judged on `bestRecalled` (retrieval) not post-filter survivors;
   - **category now comes from rule-based text matching only**, never LLM inference.
6. **Merchant listing assistant** built: `product-assistant.ts`, `listing-actions.ts`,
   `listing-wizard.tsx`, `tag-editor.tsx`, `product-tags.tsx`.
7. **Weighted search vector** — migration `0004` rewritten by hand because Drizzle emitted the
   statements in an impossible order and dropped the GIN index.
8. **`requireInStock` made rule-owned** (found while verifying this handoff): gpt-oss returned
   `false` for the plain reference query, which would silently show unbuyable products. Now
   decided by `wantsOutOfStock()` in `intent-rules.ts`; only an explicit ask widens it.
   This was a genuinely flaky test surfacing a genuine bug — worth remembering that the intent
   tests double as a guard against model drift.

---

## 3a. Changes in this session

1. **Brand duplication in assisted titles fixed.** The wizard produced
   *"Nike Nike Air Zoom Pegasus"*. Cause: the deterministic fallback (which runs when the LLM
   call fails — here almost certainly a Groq rate-limit; the row's signature was
   `search_tags: ["nike","running shoes"]` with an empty description) did
   `` `${brand} ${productName}` `` unconditionally, and the merchant had already typed the brand
   into the product name. Now both the fallback and the LLM path go through
   `composeTitle()` in `product-assistant.ts`, which skips the prefix when the name already
   contains the brand as a whole word (case-insensitive, boundary-anchored so "Peak" is not
   found inside "Peakless"). The fallback also no longer seeds the bare brand as a tag —
   the tag prompt explicitly excludes it.
2. **The affected product row was corrected in place** to `Nike Air Zoom Pegasus` and
   reindexed. If the user wanted the old title, it is editable at
   `/merchant/products/0cae1b1f-5759-445b-b25d-73ce7d15ae32`.
3. **`buildVariantCombos` + `MAX_VARIANTS` extracted** into
   `src/server/agents/merchant/variants.ts`. They lived in `listing-actions.ts`, which is
   `"use server"` and imports next-auth — that module cannot load under Vitest, so the logic
   was untestable where it was. Pure functions now live outside the server-action boundary.
4. **`src/server/agents/merchant/listing.test.ts` added** (13 tests): brand-duplication and
   word-boundary cases for `composeTitle`, cartesian expansion / empty-axis / at-the-cap /
   over-the-cap for `buildVariantCombos`, and normalisation + the 14-tag cap for `dedupeTags`.
5. **Missing product images generated** — 3 outstanding, now 68/68.

---

## 4. Pending decisions for the user

- **Repo visibility**: currently private. `gh repo edit --visibility public` to change.
- **Deployment**: needs the user's Supabase project (pooler URI) and Vercel import. Cannot be done
  without their accounts.
- **Whether to consolidate the two product-creation paths** (gap #8).
- Reference tables still lack the avatar stacks / inline progress bars / row action icons from the
  original design reference (`/Users/ParthTripathi/Documents/123image.png`). Offered, not requested.

---

## 5. Exact next steps

1. **Deploy** if the user provides Supabase/Vercel access (see `README.md` §Deploying).
   This is the only remaining item that blocks calling the project finished.
2. Decide gap #8 — whether to consolidate `createProductAction` and
   `createAssistedProductAction` into one path.
3. Optional: refunds; trim the `/merchant` bundle; richer table UI (avatar stacks, inline
   progress bars, row action icons from `123image.png`).

---

## 6. Context needed to avoid repeating work

- **Do not re-run `npm run db:seed`** — it truncates every table including real user accounts.
  Use `npm run db:seed-extra` (additive, idempotent).
- **Do not "fix" the relevance gate by lowering the threshold.** 0.34 was measured against this
  catalog (stocked 0.369–0.721, unstocked ≤0.307). If queries wrongly return nothing, the bug is
  more likely a hard filter (category/price/stock) than the threshold.
- **Do not reintroduce LLM-inferred categories as a hard filter** (see NOTES.md §8.8).
- **Do not put `box-shadow` on cards in CSS** (§8.3) — it erases every ring, including the gold
  best-match border.
- The user has repeatedly and correctly caught UI regressions that "passed" my scripted patches.
  **Always `grep` after a scripted edit to confirm the anchor matched.**
- Colours the user chose explicitly: best-match border `#E4DA72`, agent CTA `#3E0F8D`,
  primary `#7F56D9`, sidebar `#101828`, page `#f7f8fa`, cards `#ffffff`.
- **The listing assistant's deterministic fallback is not a rare path.** Groq rate-limits, and
  when it does, `buildFallbackDraft()` is what the merchant actually sees. Every change to the
  LLM path needs the same change in the fallback — the brand-duplication bug was exactly this
  omission. Both now share `composeTitle()`.
- **Do not put pure logic inside a `"use server"` module.** Those files import next-auth, which
  fails to load under Vitest, so anything in them is untestable. Extract to a plain module
  (`variants.ts` is the pattern) and import it back.
