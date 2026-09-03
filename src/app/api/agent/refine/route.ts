import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { refineProduct } from "@/server/agents/customer/refine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  productId: z.string().min(1),
  message: z.string().min(1).max(400),
  currentVariantId: z.string().max(36).nullish(),
});

/** Conversation about ONE product — colour, size, price, or a question. */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  try {
    const result = await refineProduct({
      productId: parsed.data.productId,
      message: parsed.data.message,
      currentVariantId: parsed.data.currentVariantId ?? null,
    });
    if (!result) return NextResponse.json({ error: "That product is no longer available." }, { status: 404 });
    return NextResponse.json(result);
  } catch (cause) {
    return NextResponse.json({ error: (cause as Error).message }, { status: 500 });
  }
}
