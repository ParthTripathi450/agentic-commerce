import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { merchants } from "@/db/schema";
import { auth } from "@/lib/auth";

export async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  return session.user;
}

export async function requireCustomer() {
  const user = await requireUser();
  if (user.role !== "customer" && user.role !== "admin") redirect("/merchant");
  return user;
}

/** Resolves the merchant profile owned by the signed-in user. */
export async function requireMerchant() {
  const user = await requireUser();
  if (user.role !== "merchant" && user.role !== "admin") redirect("/shop");

  const [merchant] = await db
    .select()
    .from(merchants)
    .where(eq(merchants.userId, user.id))
    .limit(1);

  if (!merchant) redirect("/merchant/onboarding");
  return { user, merchant };
}
