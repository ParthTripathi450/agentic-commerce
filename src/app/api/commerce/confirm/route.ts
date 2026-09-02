import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { confirmPayment } from "@/server/commerce/checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  orderId: z.string().min(1),
  gatewayPaymentId: z.string().min(1),
  signature: z.string().min(1),
  agentSessionId: z.string().max(36).optional(),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  const result = await confirmPayment({
    userId: session.user.id,
    orderId: parsed.data.orderId,
    gatewayPaymentId: parsed.data.gatewayPaymentId,
    signature: parsed.data.signature,
    sessionId: parsed.data.agentSessionId,
  });
  return NextResponse.json(result);
}
