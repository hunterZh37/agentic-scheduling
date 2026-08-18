import { toolsFor } from "./tools";

// Minimal MCP server over JSON-RPC 2.0, stateless.
//
// The official SDK's transports assume a long-lived Node server holding session
// state; on Vercel each request is its own isolated invocation, so instead we
// implement the Streamable HTTP shape directly: one POST carries one JSON-RPC
// request and gets one JSON-RPC response. No sessions, nothing to resume,
// nothing to leak between callers.

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "bookwithhunter", version: "1.0.0" };

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

// Standard JSON-RPC codes; -32002 is MCP's "not authorized" convention.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
const UNAUTHORIZED = -32002;

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}
function err(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/// Handle one JSON-RPC message. `authed` is whether the caller presented the
/// private bearer token; it gates both which tools are listed and which may be
/// called. Returns null for notifications (no id), which get an empty 202.
export async function handleRpc(
  body: unknown,
  authed: boolean
): Promise<JsonRpcResponse | null> {
  if (body === null || typeof body !== "object") {
    return err(null, PARSE_ERROR, "Parse error: body must be a JSON-RPC object");
  }
  const req = body as JsonRpcRequest;
  const id = req.id ?? null;
  const method = req.method;
  if (typeof method !== "string") {
    return err(id, INVALID_REQUEST, "Invalid request: missing method");
  }

  // Notifications (no id) are fire-and-forget; MCP clients send
  // notifications/initialized after the handshake.
  const isNotification = req.id === undefined || req.id === null;

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Scheduling tools for Hunter Zhang. Without a token you can see free slots and book a meeting. " +
          "A bearer token additionally unlocks reading and editing the real calendar.",
      });

    case "ping":
      return ok(id, {});

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "tools/list":
      return ok(id, {
        tools: toolsFor(authed).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case "tools/call": {
      const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
      const name = typeof params.name === "string" ? params.name : "";
      const tool = toolsFor(authed).find((t) => t.name === name);
      if (!tool) {
        // Deliberately identical message whether the tool is unknown or merely
        // private: an unauthenticated caller learns nothing about what exists.
        return err(id, authed ? METHOD_NOT_FOUND : UNAUTHORIZED, `Unknown or unavailable tool: ${name}`);
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await tool.run(args);
        // MCP tool results are content blocks; JSON goes back as text.
        return ok(id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
        });
      } catch (e) {
        // Tool-level failures are reported as isError results (not JSON-RPC
        // errors) so the calling model can read the message and adapt.
        return ok(id, {
          content: [{ type: "text", text: e instanceof Error ? e.message : "Tool failed" }],
          isError: true,
        });
      }
    }

    default:
      if (isNotification) return null;
      return err(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

export const RPC_ERROR_CODES = { PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INTERNAL_ERROR, UNAUTHORIZED };
