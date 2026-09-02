import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prepareGroupCheckout } from "@/server/commerce/group-checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One proposal covering every open cart. Never charges. */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  try {
    const result = await prepareGroupCheckout({
      userId: session.user.id,
      agentIdentifier: request.headers.get("ucp-agent") ?? "acp-web-agent/1.0",
    });
    // A policy refusal is a valid, explainable answer — 200 with the reason.
    return NextResponse.json(result);
  } catch (cause) {
    return NextResponse.json({ error: (cause as Error).message }, { status: 500 });
  }
}
