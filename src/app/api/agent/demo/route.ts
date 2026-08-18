import { NextRequest } from "next/server";
import { runNegotiation, type NegotiationEvent } from "@/lib/agent/negotiationDemo";
import { PERSONAS, pickPersona } from "@/lib/agent/personas";
import { checkDemoAllowed } from "@/lib/agent/rateLimit";

export const runtime = "nodejs";
export const maxDuration = 60;

const enc = new TextEncoder();
const frame = (e: NegotiationEvent | { type: string; message?: string }) =>
  enc.encode(`data: ${JSON.stringify(e)}\n\n`);

// Live agent-to-agent negotiation demo (SSE). Read-only + dry-run: streams a
// two-agent negotiation grounded in the owner's real availability but never books.
// Rate-limited per IP because each run costs several LLM calls.
export async function GET(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: NegotiationEvent | { type: string; message?: string }) => {
        try {
          controller.enqueue(frame(e));
        } catch {
          /* stream already closed (client disconnected) */
        }
      };

      if (!checkDemoAllowed(`demo:${ip}`).ok) {
        emit({ type: "error", message: "Too many demo runs — please wait a bit and try again." });
        emit({ type: "done" });
        controller.close();
        return;
      }

      const persona = pickPersona(Math.floor(Math.random() * PERSONAS.length));
      try {
        await runNegotiation(persona, emit); // emits its own "done" in finally
      } catch (err) {
        emit({ type: "error", message: err instanceof Error ? err.message : "Unknown error" });
        emit({ type: "done" });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
