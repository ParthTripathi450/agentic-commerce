import { NextResponse } from "next/server";
import { buildUcpManifest } from "@/server/protocols/ucp/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ merchant: string }> },
) {
  const { merchant } = await params;
  const manifest = await buildUcpManifest(merchant);
  if (!manifest) {
    return NextResponse.json({ error: "Unknown merchant" }, { status: 404 });
  }
  return NextResponse.json(manifest, {
    headers: {
      // Public, agent-readable, and safe to cache briefly.
      "Cache-Control": "public, max-age=60",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
