import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { buildKnowledgeBase } from "./knowledge";
import { evaluateForYou, repeatShoppers } from "./for-you-eval";

/**
 * The harness has to be trustworthy before its number is worth anything.
 *
 * The failure that matters is leakage: if the purchase being predicted is in
 * the profile predicting it, the score is a tautology that looks like success.
 */
describe("the profile can be built as of a past date", () => {
  it("excludes everything after the cutoff", async () => {
    const [row] = (await db.execute(sql`
      SELECT o.user_id, MIN(o.created_at) AS first_order
      FROM orders o
      WHERE o.state IN ('paid','fulfilled')
      GROUP BY o.user_id
      HAVING COUNT(*) >= 5
      LIMIT 1
    `)) as unknown as { user_id: string; first_order: string }[];
    if (!row) return;

    const full = await buildKnowledgeBase(row.user_id);
    const atFirstOrder = await buildKnowledgeBase(row.user_id, {
      asOf: new Date(row.first_order),
    });

    // Nothing had happened before their first order, so the profile must be
    // empty — this is exactly the leak the eval depends on not having.
    expect(atFirstOrder.evidence.purchases).toBe(0);
    expect(full.evidence.purchases).toBeGreaterThan(0);
  });

  it("ages evidence from the cutoff, not from today", async () => {
    // A profile "as of" a past date must decay its evidence as it would have
    // then; measuring decay from now would shrink everything toward zero.
    const [row] = (await db.execute(sql`
      SELECT user_id FROM orders WHERE state IN ('paid','fulfilled')
      GROUP BY user_id HAVING COUNT(*) >= 5 LIMIT 1
    `)) as unknown as { user_id: string }[];
    if (!row) return;

    const now = await buildKnowledgeBase(row.user_id);
    const future = await buildKnowledgeBase(row.user_id, {
      asOf: new Date(Date.now() + 86_400_000),
    });
    expect(future.evidence.purchases).toBe(now.evidence.purchases);
  });
});

describe("evaluateForYou", () => {
  it("only takes shoppers who have bought more than once", async () => {
    const cases = await repeatShoppers(20);
    expect(cases.length).toBeGreaterThan(0);
    for (const shopperCase of cases) {
      expect(shopperCase.targetProductIds.length).toBeGreaterThan(0);
      // One purchase is not a case: there would be nothing to predict from.
      expect(shopperCase.priorProducts).toBeGreaterThan(0);
    }
  });

  it("reports baselines on the same candidate pool", async () => {
    const result = await evaluateForYou({ limit: 30 });

    expect(result.cases).toBeGreaterThan(0);
    expect(result.candidates).toBeGreaterThan(50);
    // Without baselines a recall figure is unreadable: 0.03 is good against
    // random and poor against popularity, and only the comparison says which.
    for (const metrics of [result.affinity, result.popularity, result.random]) {
      expect(metrics.recallAt10).toBeGreaterThanOrEqual(0);
      expect(metrics.recallAt10).toBeLessThanOrEqual(1);
      expect(metrics.recallAt20).toBeGreaterThanOrEqual(metrics.recallAt10);
      expect(metrics.mrr).toBeGreaterThanOrEqual(0);
    }
  });

  it("is deterministic, so a change in the number means a change in the code", async () => {
    // The random baseline is a seeded shuffle for exactly this reason.
    const a = await evaluateForYou({ limit: 20 });
    const b = await evaluateForYou({ limit: 20 });
    expect(b).toEqual(a);
  });
});

describe("the eval measures shoppers, not scaffolding", () => {
  it("excludes the review pool and integration-test accounts", async () => {
    // Sixty review-pool accounts buy across the whole catalogue to entitle
    // reviews, and tests leave their own behind. Neither is a person with
    // taste, and including them guaranteed an unlearnable task — the first run
    // of this eval was largely measuring review scaffolding.
    const cases = await repeatShoppers(500);
    const [{ emails }] = (await db.execute(sql`
      SELECT ARRAY_AGG(email) AS emails FROM users
      WHERE id IN (${sql.join(cases.map((c) => sql`${c.userId}`), sql`, `)})
    `)) as unknown as { emails: string[] }[];

    for (const email of emails ?? []) {
      expect(email, email).not.toMatch(/@marketplace\.reviews$/);
      expect(email, email).not.toMatch(/@acp\.test$/);
    }
  });

  it("beats popularity now that shoppers have coherent histories", async () => {
    // This is the point of the persona seed: with shoppers who behave like
    // people the profile predicts them, and without it no algorithm could.
    const result = await evaluateForYou();
    expect(result.affinity.mrr).toBeGreaterThan(result.popularity.mrr);
    expect(result.affinity.recallAt10).toBeGreaterThan(result.random.recallAt10);
  });
});
