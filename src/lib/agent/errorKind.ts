// Turn a raw agent/Anthropic failure into a KIND the dashboard can show as a
// clear status ("Alex is offline: credits low") instead of dumping the raw
// provider error into the chat. Pure + testable — no SDK import needed.

export type AgentErrorKind = "billing" | "auth" | "overloaded" | "error";

export interface ClassifiedAgentError {
  kind: AgentErrorKind;
  message: string;
}

/// Classify an unknown thrown error. Matches on HTTP status when present and on
/// the provider's message text, which is the only signal for the credit case.
export function classifyAgentError(err: unknown): ClassifiedAgentError {
  const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : undefined;
  const raw = err instanceof Error ? err.message : String(err ?? "");

  // Out of credits — a 400 whose message names the credit balance.
  if (/credit balance is too low|insufficient credit|billing/i.test(raw)) {
    return {
      kind: "billing",
      message:
        "Alex is offline: the Anthropic API is out of credits. Add credits, and make sure the live key belongs to the funded organization.",
    };
  }
  // Bad / expired / missing key.
  if (status === 401 || /authentication|invalid x-api-key|could not resolve authentication|api key|expired|revoked/i.test(raw)) {
    return {
      kind: "auth",
      message:
        "Alex is offline: the Anthropic API key is invalid, expired, or revoked. Update ANTHROPIC_API_KEY in the deployment.",
    };
  }
  // Transient capacity / rate limiting — recoverable.
  if (status === 429 || status === 529 || /overloaded|rate limit|too many requests/i.test(raw)) {
    return { kind: "overloaded", message: "Alex is momentarily overloaded or rate-limited. Try again in a few seconds." };
  }
  return { kind: "error", message: "Alex hit an unexpected error. Please try again." };
}
