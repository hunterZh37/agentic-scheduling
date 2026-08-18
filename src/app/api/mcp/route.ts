import { NextRequest, NextResponse } from "next/server";
import { optionalEnv } from "@/lib/env";
import { handleRpc, MCP_PROTOCOL_VERSION, SERVER_INFO } from "@/lib/mcp/rpc";
import { toolsFor } from "@/lib/mcp/tools";
import { tryReserveBooking, releaseBooking } from "@/lib/agent/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// MCP (Model Context Protocol) endpoint — lets other agents connect to this
// scheduling app as a tool server.
//
// TWO TIERS, decided per request by the bearer token:
//   - No token  → public tools only: free/busy and booking. These never reveal
//     event titles, attendees, or anything about who the owner is meeting —
//     the same posture as the public booking page and /api/agent/negotiate.
//   - Valid MCP_TOKEN → also the private tools: read the real schedule and
//     create/update/delete events, blocks, actionables and reminders.
//
// Unauthenticated callers don't even see the private tools in tools/list, so
// the endpoint reveals nothing about what the owner tracks.
//
// Transport is stateless Streamable HTTP: one POST = one JSON-RPC message.
// Sessions would need shared state that serverless doesn't have, and aren't
// required by the spec.

function isAuthed(req: NextRequest): boolean {
  const token = optionalEnv("MCP_TOKEN");
  // No token configured → the private tier is simply disabled. It must never
  // fail OPEN: an unset secret granting full calendar access is exactly the
  // failure mode we avoid elsewhere in this app.
  if (!token) return false;
  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (presented.length !== token.length) return false;
  // Constant-time-ish compare so the token can't be discovered byte-by-byte.
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= presented.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

/// Whether an RPC message is a public-tier create_booking call. Only those
/// consume the per-IP booking reservation below.
function isCreateBookingCall(m: unknown): boolean {
  if (!m || typeof m !== "object") return false;
  const msg = m as { method?: unknown; params?: { name?: unknown } };
  return msg.method === "tools/call" && msg.params?.name === "create_booking";
}

/// Run one RPC message, holding the shared per-IP booking reservation across
/// any unauthenticated create_booking call. Every other public booking path
/// (the booking page API, the web/Slack public agents) already goes through
/// tryReserveBooking — MCP was the one anonymous door with no limit, i.e. an
/// unbounded real-calendar-write and owner-alert-spam loop. The reservation is
/// returned when the tool reports failure so a rejected slot doesn't burn the
/// caller's booking.
async function handleLimited(m: unknown, authed: boolean, ip: string) {
  if (authed || !isCreateBookingCall(m)) return handleRpc(m, authed);
  if (!tryReserveBooking(ip)) {
    const id = (m as { id?: unknown }).id ?? null;
    return {
      jsonrpc: "2.0" as const,
      id: id as string | number | null,
      error: { code: -32000, message: "Rate limit: this address has already created a booking." },
    };
  }
  const result = await handleRpc(m, authed);
  const failed =
    !result ||
    "error" in result ||
    (result.result as { isError?: boolean } | undefined)?.isError === true;
  if (failed) releaseBooking(ip);
  return result;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400 }
    );
  }

  const authed = isAuthed(req);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";

  // Batches are permitted by JSON-RPC; handle them so compliant clients work.
  if (Array.isArray(body)) {
    const results = await Promise.all(body.map((m) => handleLimited(m, authed, ip)));
    const answers = results.filter((r) => r !== null);
    return answers.length === 0
      ? new NextResponse(null, { status: 202 })
      : NextResponse.json(answers);
  }

  const result = await handleLimited(body, authed, ip);
  // Notifications get no body.
  if (result === null) return new NextResponse(null, { status: 202 });
  return NextResponse.json(result);
}

/// Discovery for humans and for clients that probe with GET. Advertises the
/// server and which tools the CALLER can currently use, so a misconfigured
/// token is obvious immediately.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const authed = isAuthed(req);
  return NextResponse.json({
    ...SERVER_INFO,
    protocolVersion: MCP_PROTOCOL_VERSION,
    transport: "streamable-http",
    endpoint: "/api/mcp",
    authenticated: authed,
    privateTierConfigured: !!optionalEnv("MCP_TOKEN"),
    tools: toolsFor(authed).map((t) => ({ name: t.name, tier: t.tier, description: t.description })),
  });
}
