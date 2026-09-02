import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { payGroupAsAgent } from "@/server/commerce/group-checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ groupId: z.string().min(1) });

/** The agent settles an already-authorised group and reports what it did. */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  try {
    return NextResponse.json(
      await payGroupAsAgent({ userId: session.user.id, groupId: parsed.data.groupId }),
    );
  } catch (cause) {
    return NextResponse.json({ error: (cause as Error).message }, { status: 500 });
  }
}
