import { describe, it, expect } from "vitest";
import { handleRpc, MCP_PROTOCOL_VERSION } from "./rpc";
import { toolsFor, MCP_TOOLS } from "./tools";

const call = (method: string, params?: Record<string, unknown>, authed = false) =>
  handleRpc({ jsonrpc: "2.0", id: 1, method, params }, authed);

describe("MCP handshake", () => {
  it("responds to initialize with the protocol version and server info", async () => {
    const r = await call("initialize");
    expect(r).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: "bookwithhunter" } },
    });
  });

  it("treats notifications (no id) as fire-and-forget", async () => {
    expect(await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, false)).toBeNull();
  });

  it("rejects a malformed body", async () => {
    const r = await handleRpc("not an object", false);
    expect(r).toMatchObject({ error: { code: -32700 } });
  });

  it("returns method-not-found for an unknown method", async () => {
    expect(await call("does/not/exist")).toMatchObject({ error: { code: -32601 } });
  });
});

// The tier boundary is the security-critical property of this server: an
// unauthenticated agent must neither see nor be able to invoke anything that
// touches the real calendar.
describe("tier isolation", () => {
  it("lists only public tools to an unauthenticated caller", async () => {
    const r = (await call("tools/list", {}, false)) as { result: { tools: Array<{ name: string }> } };
    const names = r.result.tools.map((t) => t.name);
    expect(names).toEqual(["get_availability", "find_mutual_times", "create_booking"]);
  });

  it("never exposes a private tool name to an unauthenticated caller", async () => {
    const r = (await call("tools/list", {}, false)) as { result: { tools: Array<{ name: string }> } };
    const listed = new Set(r.result.tools.map((t) => t.name));
    for (const t of MCP_TOOLS.filter((t) => t.tier === "private")) {
      expect(listed.has(t.name)).toBe(false);
    }
  });

  it("lists private tools once authenticated", async () => {
    const r = (await call("tools/list", {}, true)) as { result: { tools: Array<{ name: string }> } };
    const names = r.result.tools.map((t) => t.name);
    expect(names).toContain("get_schedule");
    expect(names).toContain("delete_event");
  });

  it("refuses to CALL a private tool without auth", async () => {
    const r = await call("tools/call", { name: "get_schedule", arguments: {} }, false);
    expect(r).toMatchObject({ error: { code: -32002 } });
  });

  it("gives the same error for unknown and private tools, leaking nothing", async () => {
    const priv = (await call("tools/call", { name: "get_schedule" }, false)) as { error: { code: number } };
    const bogus = (await call("tools/call", { name: "no_such_tool" }, false)) as { error: { code: number } };
    expect(priv.error.code).toBe(bogus.error.code);
  });

  it("every public tool is free/busy or booking only — none read the calendar", () => {
    // Guard against a future private tool being mislabelled public.
    expect(toolsFor(false).map((t) => t.name).sort()).toEqual(
      ["create_booking", "find_mutual_times", "get_availability"].sort()
    );
  });
});

describe("tools/call error handling", () => {
  it("reports a tool failure as isError content, not a transport error", async () => {
    // Invalid date → the tool throws → surfaced so the model can adapt.
    const r = (await call(
      "tools/call",
      { name: "get_availability", arguments: { startISO: "nope", endISO: "nope" } },
      false
    )) as { result: { isError?: boolean } };
    expect(r.result.isError).toBe(true);
  });
});
