# Agentic Commerce Platform

A multi-merchant marketplace built for AI buyers. Merchants publish once and become
discoverable, comparable and transactible by agents; shoppers describe what they want in plain
language and an agent searches every merchant, ranks the options, explains its choice, and asks
permission before it spends anything.

**Built entirely on free tiers, with no credit card required anywhere.**

---

## The one idea that shapes everything

**The LLM is not the search engine, the ranker, or the executor. It is the interpreter and the narrator.**

```
NL query ──LLM──> structured intent ──Postgres (pgvector + FTS + filters)──> candidates
                                    ──deterministic scorer──> ranked, with per-criterion scores
                                    ──LLM──> explanation generated from those real scores
                                    ──policy engine──> ALLOW | REQUIRE_APPROVAL | DENY
                                    ──AP2 mandate chain──> payment
```

Two LLM calls per shopping turn, not twenty. That keeps it inside a free tier, but it is also
simply the right design: the "why I picked this" text is generated **from** the score vector, so
it cannot invent a reason the ranker did not use, and the ranking is reproducible and unit-testable.

## Quick start

```bash
npm install
cp .env.example .env.local        # then fill in DATABASE_URL and AUTH_SECRET

createdb agentic_commerce
psql -d agentic_commerce -c 'CREATE EXTENSION vector; CREATE EXTENSION pgcrypto;'

npm run db:migrate                # apply schema
npm run db:seed                   # 6 merchants, 39 products, 90 days of orders
npm run catalog:index             # build the AI-readable catalog + embeddings
npm run doctor                    # verify every dependency before you start
npm run dev
```

Sign in with `demo@shopper.test` (customer) or `care@stride.test` (merchant), password `demo1234`.
Ask the agent: *"Find me black running shoes, size 10, under ₹5,000."*

Razorpay test card: **4100 2800 0000 1007**, any future expiry, any CVV.
(`4111 1111 1111 1111` is classified international and will decline.)

## Nothing is mandatory except a database

| Service | Without it | Get one |
|---|---|---|
| **Groq** (LLM) | Intent parsing and explanations fall back to deterministic rules. Everything still works. | console.groq.com/keys — email only |
| **Razorpay** | `PAYMENT_GATEWAY=mock` runs the whole purchase flow offline | razorpay.com — no KYC for test mode |
| **Supabase** | Local Postgres works identically | supabase.com — no card |
| Embeddings | — | runs locally, no key, no rate limit |

`npm run doctor` tells you exactly what is configured, what is degraded, and how to fix it.
It also catches the failure that actually bites: **free providers rotate their model catalogues**,
and a stale model id otherwise shows up as a vague fallback rather than an error.

## Protocols

| | Endpoint |
|---|---|
| **UCP** discovery | `/.well-known/ucp` |
| **UCP** manifest | `/api/ucp/{merchant}/manifest` — capabilities, payment handlers, public signing key |
| **ACP** feed | `/api/acp/{merchant}/feed.json` (`?format=csv`) |
| **MCP** HTTP | `/api/mcp` — 6 tools |
| **MCP** stdio | `npm run mcp:stdio` |
| **AP2** | Intent → Cart → Payment, ES256, hash-linked |
| **x402** | `/api/x402/insights/{merchant}` — HTTP 402 → signed retry |

The ACP feed **is** the AI-readable catalog: merchants author products in the dashboard and the
feed, the embeddings and the UCP manifest are all derived. There is no separate "publish to AI" step.

### MCP desktop clients

```json
{
  "mcpServers": {
    "agentic-commerce": { "command": "npm", "args": ["run", "mcp:stdio"], "cwd": "/path/to/this/repo" }
  }
}
```

No MCP tool can charge money. `prepare_purchase` returns an authorization URL a human opens —
the same consent boundary AP2 draws.

## Safety model

- **Every payment needs explicit human authorization.** `requireApprovalAboveMinor: 0` is the default.
- **Platform limits are a ceiling**, not a default: a per-user or per-merchant limit can only be stricter.
- **The AP2 chain is verified before charging.** Edit a cart's price after it was approved and the
  parent-hash link breaks, so the charge is refused rather than silently going through at the new price.
- **Refusals are audited as visibly as completions**, in an append-only trail.
- **The merchant agent proposes; it never acts alone.** Restock, promotion and availability changes
  all pass the policy engine and then a human.

## Deploying

Free tier, no card, roughly fifteen minutes.

**1. Database — Supabase**
Create a project, then SQL Editor: `CREATE EXTENSION IF NOT EXISTS vector;`
Copy the **Session pooler** URI (Project Settings → Database) into `DATABASE_URL`, then:

```bash
npm run db:migrate && npm run db:seed && npm run catalog:index
```

> Free projects pause after 7 idle days — open the dashboard to wake one.

**2. Storage — Supabase Storage**
Create a **public** bucket `product-images`, then set:

```
STORAGE_DRIVER=supabase
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key>
SUPABASE_STORAGE_BUCKET=product-images
```

Local disk is the default and is not writable on serverless hosts, so this is required once deployed.

**3. Hosting — Vercel**
Import the repo, add every variable from `.env.local`, and set `PLATFORM_URL` to the deployed
origin — protocol manifests and feeds build absolute URLs from it.

**4. Razorpay webhooks**
Dashboard → Settings → Webhooks → `https://<your-domain>/api/webhooks/razorpay`,
events `payment.captured`, `payment.failed`, `order.paid`. Put the signing secret in
`RAZORPAY_WEBHOOK_SECRET`.

Without this, an order is only settled by the browser callback — so a shopper who closes the tab
mid-payment leaves the order stuck in `pending_payment` while their money has moved. The webhook is
what closes that hole.

**5. Re-run `npm run doctor` against production.**

## Commands

| | |
|---|---|
| `npm run doctor` | preflight: database, embeddings, LLM, payments |
| `npm run db:migrate` / `db:seed` / `db:reset` | schema and demo data |
| `npm run catalog:index [-- --force]` | rebuild the AI catalog |
| `npm run mcp:stdio` | MCP server for desktop clients |
| `npm test` | full suite |

## Architecture notes

`docs/PLAN.md` carries the full design, the phase breakdown, and — more usefully — the decisions
that **changed** during the build and why: the relevance gate, confidence-adjusted ratings, the
reasoning-model token budget, and the ones that came from things actually breaking.
