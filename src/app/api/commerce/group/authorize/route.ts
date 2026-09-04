import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { authorizeGroupCheckout } from "@/server/commerce/group-checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  groupId: z.string().min(1),
  approvalIds: z.array(z.string().min(1)).min(1).max(20),
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(500).optional(),
  /** One address for every order in the group. Omitted means their default. */
  addressId: z.string().max(36).nullish(),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  try {
    return NextResponse.json(
      await authorizeGroupCheckout({ userId: session.user.id, ...parsed.data }),
    );
  } catch (cause) {
    return NextResponse.json({ error: (cause as Error).message }, { status: 500 });
  }
}
