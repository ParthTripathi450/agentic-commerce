import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });

/**
 * Preflight check for the whole free-tier stack.
 *
 * Free providers rotate their model catalogues and rate limits without notice,
 * so a stale model id or an expired key shows up as a vague runtime fallback
 * rather than an obvious error. This turns all of that into one explicit report.
 */

type Status = "ok" | "warn" | "fail";
const results: Array<{ area: string; status: Status; detail: string; fix?: string }> = [];

function add(area: string, status: Status, detail: string, fix?: string) {
  results.push({ area, status, detail, fix });
}

async function checkDatabase() {
  if (!process.env.DATABASE_URL) {
    return add("database", "fail", "DATABASE_URL is not set", "Add it to .env.local");
  }
  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  try {
    const [{ version }] = await sql<{ version: string }[]>`SELECT version()`;
    const ext = await sql<{ extname: string }[]>`SELECT extname FROM pg_extension WHERE extname IN ('vector','pgcrypto')`;
    const names = ext.map((e) => e.extname);
    add("database", "ok", version.split(",")[0]);

    if (!names.includes("vector")) {
      add("pgvector", "fail", "extension missing", "CREATE EXTENSION vector;");
    } else {
      add("pgvector", "ok", "installed");
    }

    const [{ count: products }] = await sql<{ count: string }[]>`SELECT count(*) FROM products`;
    const [{ count: merchants }] = await sql<{ count: string }[]>`SELECT count(*) FROM merchants`;
    const [{ count: orders }] = await sql<{ count: string }[]>`SELECT count(*) FROM orders`;
    const [{ count: embedded }] = await sql<{ count: string }[]>`SELECT count(*) FROM catalog_documents WHERE embedding IS NOT NULL`;

    add("seed data", Number(products) > 0 ? "ok" : "warn",
      `${merchants} merchants, ${products} products, ${orders} orders`,
      Number(products) > 0 ? undefined : "npm run db:seed");

    const missing = Number(products) - Number(embedded);
    add("catalog index", missing === 0 && Number(products) > 0 ? "ok" : "warn",
      `${embedded}/${products} products embedded`,
      missing > 0 ? "npm run catalog:index" : undefined);
  } catch (e) {
    add("database", "fail", (e as Error).message, "Is Postgres running? brew services start postgresql@17");
  } finally {
    await sql.end();
  }
}

async function checkEmbeddings() {
  try {
    const { embedOne } = await import("@/server/ai/embeddings");
    const t = Date.now();
    const v = await embedOne("preflight check");
    add("embeddings", "ok", `local model, ${v.length} dims, ${Date.now() - t}ms cold`);
  } catch (e) {
    add("embeddings", "fail", (e as Error).message);
  }
}

/** Verifies each configured provider can actually serve the model we ask for. */
async function checkLlm() {
  const { providerStatus, providerChain } = await import("@/server/ai/llm");
  const status = providerStatus();

  if (!status.usable) {
    return add("llm", "warn", "no provider configured — running on deterministic fallbacks",
      "Add GROQ_API_KEY to .env.local (console.groq.com/keys, no card)");
  }

  for (const provider of providerChain()) {
    try {
      const t = Date.now();
      const res = await provider.complete({
        task: "generic",
        messages: [{ role: "user", content: "Reply with the single word: OK" }],
        maxTokens: 200,
        temperature: 0,
        reasoningEffort: "low",
      });
      add(`llm:${provider.name}`, "ok", `${res.model} responded in ${Date.now() - t}ms`);
    } catch (e) {
      const msg = (e as Error).message;
      const stale = /does not exist|not found|decommissioned/i.test(msg);
      add(`llm:${provider.name}`, "fail", msg.slice(0, 160),
        stale
          ? `Model id is stale. List valid ids: curl -s https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"`
          : undefined);
    }
  }
}

/** Read-only credential check — creates nothing on the Razorpay account. */
async function checkRazorpay() {
  const id = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  const gateway = process.env.PAYMENT_GATEWAY ?? "mock";

  if (!id || !secret) {
    return add("razorpay", gateway === "razorpay" ? "fail" : "warn",
      "credentials not set", "PAYMENT_GATEWAY=mock works without them");
  }
  if (!id.startsWith("rzp_test_")) {
    return add("razorpay", "fail",
      `key is NOT a test key (starts "${id.slice(0, 9)}")`,
      "This project must only ever use rzp_test_ keys");
  }

  try {
    const res = await fetch("https://api.razorpay.com/v1/payments?count=1", {
      headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401) {
      add("razorpay", "fail", "401 Unauthorized — key/secret mismatch", "Regenerate test keys in the Razorpay dashboard");
    } else if (!res.ok) {
      add("razorpay", "warn", `HTTP ${res.status}`);
    } else {
      add("razorpay", "ok", `test-mode credentials valid (gateway=${gateway})`,
        gateway !== "razorpay" ? "Set PAYMENT_GATEWAY=razorpay to use them" : undefined);
    }
  } catch (e) {
    add("razorpay", "warn", `could not reach API: ${(e as Error).message}`);
  }
}

async function main() {
  await checkDatabase();
  await checkEmbeddings();
  await checkLlm();
  await checkRazorpay();

  const icon = { ok: "PASS", warn: "WARN", fail: "FAIL" } as const;
  console.log("\nAgentic Commerce Platform — preflight\n");
  for (const r of results) {
    console.log(`  [${icon[r.status]}] ${r.area.padEnd(16)} ${r.detail}`);
    if (r.fix) console.log(`         ↳ ${r.fix}`);
  }

  const failures = results.filter((r) => r.status === "fail").length;
  const warnings = results.filter((r) => r.status === "warn").length;
  console.log(`\n${results.length} checks — ${failures} failed, ${warnings} warnings\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
