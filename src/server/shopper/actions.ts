"use server";

import { revalidatePath } from "next/cache";
import { requireCustomer } from "@/lib/session";
import { deleteShopperSignals } from "./signals";

/**
 * Forget the browsing history behind the knowledge base.
 *
 * Only the weak signals are erasable here. Orders and reviews stay: they are
 * records of real transactions with merchants, not preferences we inferred, and
 * quietly deleting them to satisfy a preference toggle would corrupt the
 * shopper's own order history. The page says which is which rather than
 * offering a button that silently does less than it claims.
 */
export async function clearBrowsingSignalsAction(): Promise<{ ok: boolean; message: string }> {
  const user = await requireCustomer();
  const removed = await deleteShopperSignals(user.id);
  revalidatePath("/preferences");
  return {
    ok: true,
    message:
      removed === 0
        ? "There was no browsing history to clear."
        : `Cleared ${removed} browsing signal${removed === 1 ? "" : "s"}. Your orders and reviews are untouched.`,
  };
}
