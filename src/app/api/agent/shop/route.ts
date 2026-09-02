import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { runShoppingTurn } from "@/server/agents/customer/agent";
import { toTurnDto } from "@/server/agents/customer/dto";

// Embeddings and the Postgres driver both require the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  message: z.string().min(2, "Say what you are looking for").max(500),
  sessionId: z.string().max(36).optional(),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Sign in to use the shopping agent." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }

  try {
    const turn = await runShoppingTurn({
      userId: session.user.id,
      message: parsed.data.message,
      sessionId: parsed.data.sessionId,
    });
    return NextResponse.json(toTurnDto(turn));
  } catch (cause) {
    // A failed turn must still be legible to the shopper, not a blank screen.
    console.error("shopping turn failed", cause);
    return NextResponse.json(
      {
        error:
          "The shopping agent could not complete that request. The failure has been recorded in the audit trail.",
        detail: (cause as Error).message,
      },
      { status: 500 },
    );
  }
}
