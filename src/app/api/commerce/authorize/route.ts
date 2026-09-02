import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { authorizeCheckout } from "@/server/commerce/checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
  agentSessionId: z.string().max(36).optional(),
  note: z.string().max(300).optional(),
});

/** The consent gate: only an explicit approve here can lead to a charge. */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  const result = await authorizeCheckout({
    userId: session.user.id,
    approvalId: parsed.data.approvalId,
    decision: parsed.data.decision,
    sessionId: parsed.data.agentSessionId,
    note: parsed.data.note,
  });
  return NextResponse.json(result);
}
