import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { confirmGroupPayment } from "@/server/commerce/group-checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  groupId: z.string().min(1),
  gatewayPaymentId: z.string().min(1),
  signature: z.string().min(1),
});

/** Settles every order in the group against one verified signature. */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  try {
    return NextResponse.json(
      await confirmGroupPayment({ userId: session.user.id, ...parsed.data }),
    );
  } catch (cause) {
    return NextResponse.json({ error: (cause as Error).message }, { status: 500 });
  }
}
