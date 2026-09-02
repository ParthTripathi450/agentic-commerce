import { NextResponse } from "next/server";
import { buildFeed, feedToCsv } from "@/server/protocols/acp/feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ merchant: string }> },
) {
  const { merchant } = await params;
  const feed = await buildFeed(merchant);
  if (!feed) return NextResponse.json({ error: "Unknown merchant" }, { status: 404 });

  // Agents that ingest tabular feeds ask for CSV; the data is identical.
  if (new URL(request.url).searchParams.get("format") === "csv") {
    return new NextResponse(feedToCsv(feed), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${merchant}-feed.csv"`,
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  return NextResponse.json(feed, {
    headers: { "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" },
  });
}
