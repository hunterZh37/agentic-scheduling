import { NextRequest, NextResponse } from "next/server";
import { runPublicAgent, type ChatMessage } from "@/lib/agent/run";
import { checkMessageAllowed, tryReserveBooking, releaseBooking } from "@/lib/agent/rateLimit";

export const runtime = "nodejs";
export const maxDuration = 60;

// The PUBLIC agent endpoint. Fenced: it constructs the agent with only the two
// safe tools, rate-limits per visitor, and permits at most one booking per
// visitor window. The private tools are never reachable from here.
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
  // Message rate can be scoped to the client's self-reported sessionId — worst
  // case an attacker resets their own message cap. The booking guard cannot:
  // it must be keyed on the IP alone (server-controlled), otherwise rotating
  // sessionId lets a visitor book unlimited times.
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
    const reply = await runPublicAgent(messages, {
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
