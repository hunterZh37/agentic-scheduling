import { NextRequest, NextResponse } from "next/server";
import { runRequesterAgent, type ChatMessage } from "@/lib/agent/run";
import { checkMessageAllowed, tryReserveBooking, releaseBooking } from "@/lib/agent/rateLimit";

export const runtime = "nodejs";
export const maxDuration = 60;

// The REQUESTER agent endpoint (outbound side of agent-to-agent scheduling).
// Fenced exactly like /api/agent/public: rate-limited per visitor, at most one
// booking per visitor. Tools are limited to find_mutual_times (free-slot
// overlap only) + create_public_booking.
export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { messages?: ChatMessage[]; sessionId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    return NextResponse.json({ error: "no_messages" }, { status: 400 });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const messageKey = `${ip}:${body.sessionId ?? "anon"}`;
  const bookingKey = ip;

  const decision = checkMessageAllowed(messageKey, Date.now(), ip);
  if (!decision.ok) {
    return NextResponse.json(
      { error: decision.reason, message: "Rate limit reached. Please try again later." },
      { status: 429 }
    );
  }

  try {
    const reply = await runRequesterAgent(messages, {
      tryReserveBooking: () => tryReserveBooking(bookingKey),
      releaseBooking: () => releaseBooking(bookingKey),
    });
    return NextResponse.json({ reply });
  } catch (err) {
    return NextResponse.json(
      { error: "agent_error", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
