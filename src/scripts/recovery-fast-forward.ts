import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });

/**
 * Skip the cooldown so the later stages can be walked by hand.
 *
 *   npm run recovery:fast-forward
 *
 * After the agent contacts a shopper it will not touch that case again for 24
 * hours — the rule that stops it becoming a nuisance, and the reason two of the
 * five demo branches (a second and final message, and the bounded incentive
 * that rides with it) cannot be reached by pressing Run a sweep twice.
 *
 * **This moves the clock and nothing else.** It clears `next_action_at`, which
 * is a "not before" timestamp; it does not raise a limit, skip an approval,
 * change a diagnosis or count a recovery. Every stopping rule still applies on
 * the next sweep — which is the point, since the interesting thing to watch is
 * the message limit firing on the third attempt.
 */
async function main() {
  const { db } = await import("@/db");
  const { sql } = await import("drizzle-orm");

  const rows = (await db.execute(sql`
    UPDATE recovery_cases SET next_action_at = NULL
    WHERE next_action_at IS NOT NULL
      AND merchant_id IN (
        SELECT m.id FROM merchants m JOIN users u ON u.id = m.user_id
        WHERE u.email = 'care@stride.test'
      )
    RETURNING id`)) as unknown as unknown[];

  console.log(`${rows.length} case(s) are now eligible for the next sweep.`);
  console.log(`Press 'Run a recovery sweep' on /merchant/recovery again.`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
