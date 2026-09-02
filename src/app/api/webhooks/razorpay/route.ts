import { NextResponse } from "next/server";
import { handleRazorpayWebhook } from "@/server/commerce/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Razorpay webhook receiver.
 *
 * The raw body is read as text, not JSON: the signature is computed over the
 * exact bytes sent, so re-serialising a parsed object would break verification.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature");
  const eventId = request.headers.get("x-razorpay-event-id");

  const result = await handleRazorpayWebhook(rawBody, signature, eventId);

  // Only a signature failure is rejected. Everything else returns 200 so the
  // gateway stops retrying an event we have already recorded and reasoned about.
  const status = result.status === "invalid" ? 400 : 200;
  return NextResponse.json({ status: result.status, detail: result.detail }, { status });
}
