import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { paymentMethods } from "@/db/schema";

/** Read helpers — kept out of the "use server" module. */
export async function getDefaultPaymentMethod(userId: string) {
  const [method] = await db
    .select()
    .from(paymentMethods)
    .where(and(eq(paymentMethods.userId, userId), eq(paymentMethods.isDefault, true)))
    .limit(1);
  return method ?? null;
}

export async function listPaymentMethods(userId: string) {
  return db.select().from(paymentMethods).where(eq(paymentMethods.userId, userId));
}

export function describeMethod(method: {
  brand: string;
  last4: string;
  expiryMonth: number;
  expiryYear: number;
}) {
  const brand = method.brand.charAt(0).toUpperCase() + method.brand.slice(1);
  return `${brand} •••• ${method.last4}, expires ${String(method.expiryMonth).padStart(2, "0")}/${String(method.expiryYear).slice(-2)}`;
}
