import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { listActiveMerchantSlugs } from "@/server/protocols/acp/feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Platform-level UCP discovery.
 *
 * UCP expects a manifest at /.well-known/ucp. This deployment hosts many
 * merchants on one origin, so the well-known document is a directory: it names
 * the platform's shared services and points at each merchant's own manifest.
 */
export async function GET() {
  const base = env().PLATFORM_URL.replace(/\/$/, "");
  const slugs = await listActiveMerchantSlugs();

  return NextResponse.json(
    {
      ucp_version: "0.1",
      platform: { name: "Agentic Commerce Platform", url: base },
      services: {
        "dev.ucp.mcp": { endpoint: `${base}/api/mcp`, description: "MCP tools across all merchants" },
        "dev.ucp.search": { endpoint: `${base}/api/ucp/search`, description: "Cross-merchant catalog search" },
      },
      businesses: slugs.map((slug) => ({
        slug,
        manifest: `${base}/api/ucp/${slug}/manifest`,
        feed: `${base}/api/acp/${slug}/feed.json`,
      })),
      generated_at: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" } },
  );
}
