import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { approvals, checkoutSessions } from "@/db/schema";

/**
 * Reclaims stock held by abandoned checkouts.
 *
 * A proposal reserves stock so two shoppers cannot buy the last unit while one
 * is deciding. If the shopper simply walks away, that hold would otherwise be
 * permanent and the item would look sold out forever. This releases every
 * reservation whose checkout session has passed its expiry.
 */
export async function releaseExpiredCheckouts(): Promise<{
  sessionsExpired: number;
  unitsReleased: number;
}> {
  const expired = await db
    .select({ id: checkoutSessions.id, cartId: checkoutSessions.cartId })
    .from(checkoutSessions)
    .where(
      and(
        inArray(checkoutSessions.state, ["created", "ready", "requires_authorization"]),
        lt(checkoutSessions.expiresAt, new Date()),
      ),
    );

  if (expired.length === 0) return { sessionsExpired: 0, unitsReleased: 0 };

  const cartIds = expired.map((s) => s.cartId);

  // Release in one statement so a large sweep cannot partially apply.
  const released = await db.execute<{ released: number }>(sql`
    WITH held AS (
      SELECT ci.variant_id, SUM(ci.quantity) AS qty
      FROM cart_items ci
      WHERE ci.cart_id IN (${sql.join(cartIds.map((id) => sql`${id}`), sql`, `)})
      GROUP BY ci.variant_id
    )
    UPDATE inventory i
    SET reserved = GREATEST(i.reserved - held.qty, 0), updated_at = now()
    FROM held
    WHERE i.variant_id = held.variant_id
    RETURNING held.qty AS released
  `);

  await db
    .update(checkoutSessions)
    .set({ state: "expired", updatedAt: new Date() })
    .where(inArray(checkoutSessions.id, expired.map((s) => s.id)));

  await db
    .update(approvals)
    .set({ status: "expired" })
    .where(and(eq(approvals.status, "pending"), lt(approvals.expiresAt, new Date())));

  const unitsReleased = (released as unknown as { released: number }[]).reduce(
    (sum, row) => sum + Number(row.released),
    0,
  );
  return { sessionsExpired: expired.length, unitsReleased };
}

/** Recomputes `reserved` from live checkout sessions, healing any drift. */
export async function reconcileReservations(): Promise<number> {
  const result = await db.execute<{ variant_id: string }>(sql`
    WITH expected AS (
      SELECT ci.variant_id, COALESCE(SUM(ci.quantity), 0) AS qty
      FROM checkout_sessions cs
      JOIN cart_items ci ON ci.cart_id = cs.cart_id
      WHERE cs.state IN ('created','ready','requires_authorization')
        AND cs.expires_at > now()
      GROUP BY ci.variant_id
    )
    UPDATE inventory i
    SET reserved = COALESCE(expected.qty, 0), updated_at = now()
    FROM (SELECT variant_id, qty FROM expected) AS expected
    WHERE i.variant_id = expected.variant_id AND i.reserved <> expected.qty
    RETURNING i.variant_id
  `);

  // Anything not backed by a live session should hold nothing at all.
  const cleared = await db.execute<{ variant_id: string }>(sql`
    UPDATE inventory i
    SET reserved = 0, updated_at = now()
    WHERE i.reserved > 0
      AND NOT EXISTS (
        SELECT 1 FROM checkout_sessions cs
        JOIN cart_items ci ON ci.cart_id = cs.cart_id
        WHERE ci.variant_id = i.variant_id
          AND cs.state IN ('created','ready','requires_authorization')
          AND cs.expires_at > now()
      )
    RETURNING i.variant_id
  `);

  return (
    (result as unknown as unknown[]).length + (cleared as unknown as unknown[]).length
  );
}
