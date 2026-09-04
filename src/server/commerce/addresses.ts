import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { addresses } from "@/db/schema";

/**
 * Reading and writing a shopper's delivery addresses.
 *
 * Reads live here rather than in an `actions.ts` because every export of a
 * `"use server"` module becomes a POST endpoint — the split this codebase keeps
 * everywhere else.
 */

export type Address = typeof addresses.$inferSelect;

/** What an order carries: the address as it stood when the order was placed. */
export type AddressSnapshot = {
  label?: string;
  recipient: string;
  phone?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postcode: string;
  country: string;
};

export type AddressInput = {
  label?: string;
  recipient: string;
  phone?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postcode: string;
  country?: string;
};

/** Default first, then newest — the order a shopper expects to choose from. */
export async function listAddresses(userId: string): Promise<Address[]> {
  return db
    .select()
    .from(addresses)
    .where(eq(addresses.userId, userId))
    .orderBy(desc(addresses.isDefault), desc(addresses.createdAt));
}

export async function defaultAddress(userId: string): Promise<Address | null> {
  const [row] = await db
    .select()
    .from(addresses)
    .where(eq(addresses.userId, userId))
    .orderBy(desc(addresses.isDefault), desc(addresses.createdAt))
    .limit(1);
  return row ?? null;
}

export async function getAddress(userId: string, addressId: string): Promise<Address | null> {
  const [row] = await db
    .select()
    .from(addresses)
    .where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * Adds an address, and makes it the default when it is the first one.
 *
 * A shopper's only address being non-default would mean checkout offering
 * nothing, so the first is always the default whatever the caller asked for.
 */
export async function addAddress(
  userId: string,
  input: AddressInput,
  options: { makeDefault?: boolean } = {},
): Promise<Address> {
  const existing = await listAddresses(userId);
  const shouldDefault = options.makeDefault || existing.length === 0;

  return db.transaction(async (tx) => {
    if (shouldDefault) {
      await tx
        .update(addresses)
        .set({ isDefault: false })
        .where(eq(addresses.userId, userId));
    }

    const [row] = await tx
      .insert(addresses)
      .values({
        userId,
        label: input.label?.trim() || "Home",
        recipient: input.recipient.trim(),
        phone: input.phone?.trim() || null,
        line1: input.line1.trim(),
        line2: input.line2?.trim() || null,
        city: input.city.trim(),
        state: input.state.trim(),
        postcode: input.postcode.trim(),
        country: input.country?.trim() || "India",
        isDefault: shouldDefault,
      })
      .returning();
    return row;
  });
}

/**
 * Promotes one address and demotes the rest, in a single transaction.
 *
 * Two statements outside a transaction can fail between the clear and the set,
 * leaving a shopper with no default at all — and checkout then silently offers
 * them nothing.
 */
export async function setDefaultAddress(userId: string, addressId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ id: addresses.id })
      .from(addresses)
      .where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)))
      .limit(1);
    if (!owned) return false;

    await tx.update(addresses).set({ isDefault: false }).where(eq(addresses.userId, userId));
    await tx
      .update(addresses)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(addresses.id, addressId));
    return true;
  });
}

/**
 * Removes an address, handing the default to whatever remains.
 *
 * Deleting the default without promoting another leaves checkout with nothing
 * selected, which reads as "we lost your address" rather than "you deleted one".
 */
export async function removeAddress(userId: string, addressId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(addresses)
      .where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)))
      .limit(1);
    if (!row) return false;

    await tx.delete(addresses).where(eq(addresses.id, addressId));

    if (row.isDefault) {
      const [next] = await tx
        .select({ id: addresses.id })
        .from(addresses)
        .where(eq(addresses.userId, userId))
        .orderBy(desc(addresses.createdAt))
        .limit(1);
      if (next) {
        await tx.update(addresses).set({ isDefault: true }).where(eq(addresses.id, next.id));
      }
    }
    return true;
  });
}

/** Freezes an address into the form an order stores. */
export function toSnapshot(address: Address): AddressSnapshot {
  return {
    label: address.label,
    recipient: address.recipient,
    phone: address.phone,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: address.state,
    postcode: address.postcode,
    country: address.country,
  };
}

/** One line, for an order row or a confirmation. */
export function formatAddress(address: AddressSnapshot | null | undefined): string {
  if (!address) return "No delivery address on this order";
  return [
    address.recipient,
    address.line1,
    address.line2,
    `${address.city}, ${address.state} ${address.postcode}`,
    address.country,
  ]
    .filter(Boolean)
    .join(", ");
}

/** How many addresses this shopper has, without loading them. */
export async function addressCount(userId: string): Promise<number> {
  const [row] = (await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM addresses WHERE user_id = ${userId}
  `)) as unknown as { n: number }[];
  return row?.n ?? 0;
}
