import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prepareCheckout } from "@/server/commerce/checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  cartId: z.string().min(1),
  agentSessionId: z.string().max(36).optional(),
  intentText: z.string().max(500).optional(),
  promoCode: z.string().max(40).optional(),
});

/** Produces an authorizable proposal. Never charges. */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  try {
    const result = await prepareCheckout({
      userId: session.user.id,
      cartId: parsed.data.cartId,
      sessionId: parsed.data.agentSessionId,
      intentText: parsed.data.intentText,
      promoCode: parsed.data.promoCode,
      agentIdentifier: request.headers.get("ucp-agent") ?? "acp-web-agent/1.0",
    });
    // A policy refusal is a valid, explainable answer — 200 with the reason.
    return NextResponse.json(result);
  } catch (cause) {
    return NextResponse.json({ error: (cause as Error).message }, { status: 500 });
  }
}
