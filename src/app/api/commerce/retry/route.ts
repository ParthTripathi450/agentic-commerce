import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { retryOrderPayment } from "@/server/commerce/retry-payment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ orderId: z.string().min(1) });

/**
 * Open a fresh payment for an order whose last attempt failed.
 *
 * Deliberately a route rather than a server action: it hands back the gateway
 * order the hosted widget needs, and the widget is opened by the client. The
 * shopper still enters their own card — nothing here charges anything.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  return NextResponse.json(
    await retryOrderPayment({ userId: session.user.id, orderId: parsed.data.orderId }),
  );
}
