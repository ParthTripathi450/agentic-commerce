# PROGRESS.md — current state

Read `NOTES.md` first for architecture and conventions. This file is the state snapshot.

**Last updated:** 2026-09-02
**Health:** 101 tests passing (17 files), stable across 3 consecutive runs · 0 lint issues ·
production build clean · 34 route files · 31 tables
**Git:** clean tree, 4 commits, pushed to `origin/main`
(`efde7f1 Merchant listing assistant with weighted search tags`)
**Repo:** https://github.com/ParthTripathi450/agentic-commerce-platform (private)

**Local data:** 13 merchants · 66 active products · 321 variants · 27 categories · 910 orders ·
24 users · 66/66 indexed · **65/66 have images** (one generation failed)

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
| 1 | **Listing wizard not exercised end-to-end** | The assistant module was tested against the live LLM and the pages render, but **no product has actually been created through the wizard**. `createAssistedProductAction` has no test. **This is the highest-value next step.** |
| 2 | **Not deployed** | Runs on local Postgres. `README.md` has the Supabase + Vercel steps. Storage (`STORAGE_DRIVER=supabase`) and webhooks both need a public origin. |
| 3 | **One product image missing** | 65/66. Re-run `npm run catalog:images` (skips existing). |
| 4 | **Refunds not implemented** | Cancelling a paid order returns stock and tells the merchant to refund in the Razorpay dashboard. |
| 5 | **Saved card ≠ Razorpay rails** | Razorpay test mode cannot charge a stored card server-side without real tokenisation. Saved-method purchases settle through `MockGateway`. The UI states this. Intentional, not a bug. |
| 6 | **`/merchant` ships ~110 kB JS** | Recharts. Fine, but the obvious thing to trim. |
| 7 | **Multi-merchant checkout is sequential** | Carts are per-merchant by design (checkout, Cart Mandate and fulfilment all are). A shopper with 3 merchants checks out 3 times. |
| 8 | **Product creation has two paths** | `NewProductForm` (manual) and `ListingWizard` (assisted) use different actions (`createProductAction` vs `createAssistedProductAction`). Only the manual one predates this session. Consider consolidating. |
| 9 | **`MAX_VARIANTS = 24`** | The wizard refuses larger cartesian products and asks the merchant to trim. Not yet user-tested. |

---

## 3. Changes in the most recent session

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

## 4. Pending decisions for the user

- **Repo visibility**: currently private. `gh repo edit --visibility public` to change.
- **Deployment**: needs the user's Supabase project (pooler URI) and Vercel import. Cannot be done
  without their accounts.
- **Whether to consolidate the two product-creation paths** (gap #8).
- Reference tables still lack the avatar stacks / inline progress bars / row action icons from the
  original design reference (`/Users/ParthTripathi/Documents/123image.png`). Offered, not requested.

---

## 5. Exact next steps

1. **Create a product through the wizard end-to-end and fix whatever breaks.** Log in as
   `care@stride.test`, go to `/merchant/products/new`, run item → brand → product → details →
   Create. Confirm: product row, variants with correct SKUs, inventory rows, `search_tags`
   populated, `catalog_documents.tags_text` non-empty, and the product findable by one of its tags.
   Then add a test for `createAssistedProductAction` covering the `MAX_VARIANTS` refusal and the
   tag round-trip.
2. **Re-run `npm run catalog:images`** for the one missing image.
3. **Deploy** if the user provides Supabase/Vercel access (see `README.md` §Deploying).
4. Optional: refunds; trim the `/merchant` bundle; richer table UI.

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
