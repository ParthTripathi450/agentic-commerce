import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { addToCart, loadCart, startDirectPurchase } from "@/server/commerce/cart";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  variantId: z.string().min(1),
  quantity: z.number().int().min(1).max(10).optional(),
  agentSessionId: z.string().max(36).optional(),
  /** "replace" = buy exactly this item; "add" = append to the open cart. */
  mode: z.enum(["add", "replace"]).default("add"),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  try {
    const put = parsed.data.mode === "replace" ? startDirectPurchase : addToCart;
    const cart = await put({
      userId: session.user.id,
      variantId: parsed.data.variantId,
      quantity: parsed.data.quantity,
      agentSessionId: parsed.data.agentSessionId,
    });
    return NextResponse.json({ cart: await loadCart(cart.id) });
  } catch (cause) {
    // Stock and availability failures are expected outcomes, not server errors.
    return NextResponse.json({ error: (cause as Error).message }, { status: 409 });
  }
}
