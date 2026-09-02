import { runShoppingTurn } from "@/server/agents/customer/agent";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

async function main() {
  const [u] = await db.select().from(users).where(eq(users.email, "demo@shopper.test")).limit(1);
  const t = await runShoppingTurn({ userId: u.id, message: "am looking for some tennis sports shoes", history: [], answered: [] });
  console.log("outcome  :", t.outcome, "| degraded:", t.degraded);
  console.log("question :", t.question?.question ?? "—");
  console.log("about    :", t.question?.id ?? "—");
  console.log("intent   :", JSON.stringify({ q: t.intent.productQuery, cat: t.intent.category, attrs: t.intent.attributes }));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
