import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { runAutonomousPurchase } from "@/server/agents/customer/autonomous";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  message: z.string().min(2, "Say what you would like the agent to buy").max(500),
  quantity: z.number().int().min(1).max(5).optional(),
});

/**
 * Runs a purchase end to end and stops at the authorization gate.
 *
 * This endpoint can never charge: it returns an approval to be decided, and the
 * existing /api/commerce/authorize route is the only thing that turns one into
 * a payment.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Sign in to use the shopping agent." }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }

  try {
    const outcome = await runAutonomousPurchase({
      userId: session.user.id,
      message: parsed.data.message,
      quantity: parsed.data.quantity,
    });
    // A stop is a valid, explainable answer — 200 with the reason it stopped.
    return NextResponse.json(outcome);
  } catch (cause) {
    console.error("autonomous purchase failed", cause);
    return NextResponse.json(
      {
        error:
          "The agent could not complete that run. Nothing was charged, and the failure is in your activity log.",
        detail: (cause as Error).message,
      },
      { status: 500 },
    );
  }
}
