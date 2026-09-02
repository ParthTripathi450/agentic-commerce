import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { payWithSavedMethod } from "@/server/payments/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  approvalId: z.string().min(1),
  agentSessionId: z.string().max(36).optional(),
});

/**
 * Completes an ALREADY-APPROVED purchase with the saved method.
 *
 * The approval id is the shopper's consent: this route cannot create one, only
 * act on one they granted. Both the policy engine and the AP2 chain are checked
 * again inside the checkout service before anything is captured.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  const result = await payWithSavedMethod({
    approvalId: parsed.data.approvalId,
    sessionId: parsed.data.agentSessionId,
  });
  return NextResponse.json(result);
}
