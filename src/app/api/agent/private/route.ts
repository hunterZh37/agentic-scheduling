import { NextRequest, NextResponse } from "next/server";
import { optionalEnv } from "@/lib/env";
import { COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";
import { runPrivateAgent, type ChatMessage } from "@/lib/agent/run";
import { classifyAgentError } from "@/lib/agent/errorKind";

export const runtime = "nodejs";
export const maxDuration = 60;

// The PRIVATE agent endpoint (full access). Requires a valid session cookie
// (the same one the middleware checks) — verified here too as defense in depth.
// In local dev (no PRIVATE_AUTH_SECRET) it stays open for convenience.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = optionalEnv("PRIVATE_AUTH_SECRET");
  if (secret) {
    const token = req.cookies.get(COOKIE_NAME)?.value;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!(await verifySessionToken(secret, token, nowSeconds))) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "private_auth_not_configured" }, { status: 500 });
  }

  let body: { messages?: ChatMessage[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    return NextResponse.json({ error: "no_messages" }, { status: 400 });
  }

  try {
    // req.signal aborts when the browser disconnects — e.g. the owner pressing
    // Esc in the dashboard composer to take back a message. Threading it into
    // the agent stops the turn server-side rather than letting it finish (and
    // possibly fire a tool) after the owner has already moved on.
    const reply = await runPrivateAgent(messages, { signal: req.signal });
    return NextResponse.json({ reply });
  } catch (err) {
    // A client-abort surfaces here as an abort error; the caller is already gone,
    // so the exact status doesn't matter, but don't dress it up as a real fault.
    if (req.signal.aborted) {
      return NextResponse.json({ error: "aborted" }, { status: 499 });
    }
    // Classify the failure so the dashboard can show a clear status (credits low,
    // key invalid, overloaded) instead of a raw provider error string.
    const { kind, message } = classifyAgentError(err);
    const status = kind === "overloaded" ? 503 : kind === "error" ? 500 : 502;
    return NextResponse.json({ error: "agent_error", kind, message }, { status });
  }
}
