import { NextRequest, NextResponse } from "next/server";
import { runTeamAgent, type ChatMessage } from "@/lib/agent/run";
import { checkMessageAllowed, tryReserveBooking, releaseBooking } from "@/lib/agent/rateLimit";
import { teamForSlug, firstNamesLabel } from "@/lib/teams/resolve";
import { HOST } from "@/lib/booking/publicConfig";

export const runtime = "nodejs";
export const maxDuration = 60;

// The public agent for a JOINT booking link. Same fence as /api/agent/public
// (two safe tools, per-visitor message + booking limits), but scoped to a team:
// get_availability returns times everyone is free and the booking invites every
// host. The private tools are never reachable from here.
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await ctx.params;
  const team = await teamForSlug(slug);
  if (!team) {
    return NextResponse.json({ error: "unknown_team" }, { status: 404 });
  }

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
  // Booking guard keyed on IP alone (server-controlled); messages may be scoped
  // to the client's sessionId. Same rule as the single-host public agent.
  const messageKey = `${ip}:${body.sessionId ?? "anon"}`;
  const bookingKey = `team:${team.id}:${ip}`;

  const decision = checkMessageAllowed(messageKey, Date.now(), ip);
  if (!decision.ok) {
    return NextResponse.json(
      { error: decision.reason, message: "Rate limit reached. Please try again later." },
      { status: 429 }
    );
  }

  const memberNames = [HOST.name, ...team.coHosts.map((c) => c.name)];
  try {
    const reply = await runTeamAgent(
      messages,
      {
        tryReserveBooking: () => tryReserveBooking(bookingKey),
        releaseBooking: () => releaseBooking(bookingKey),
      },
      {
        id: team.id,
        coHostIds: team.coHostIds,
        coHostEmails: team.coHosts.map((c) => c.email),
        // "meeting with …" names the people (co-hosts first), not the team's
        // internal name, matching the Pick-a-time flow.
        name: firstNamesLabel([...team.coHosts.map((c) => c.name), HOST.name]),
        hosts: [
          ...team.coHosts.map((c) => ({ name: c.name, linkedin: c.linkedin })),
          { name: HOST.name, linkedin: HOST.linkedin || null },
        ],
      },
      memberNames
    );
    return NextResponse.json({ reply });
  } catch (err) {
    return NextResponse.json(
      { error: "agent_error", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
