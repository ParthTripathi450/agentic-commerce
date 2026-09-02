import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { recommendationsFor } from "@/server/catalog/recommendations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ productId: z.string().min(1), limit: z.number().int().min(1).max(8).default(4) });

/** What goes with something the shopper just added. */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  try {
    return NextResponse.json({
      recommendations: await recommendationsFor(parsed.data.productId, parsed.data.limit),
    });
  } catch (cause) {
    return NextResponse.json({ error: (cause as Error).message }, { status: 500 });
  }
}
