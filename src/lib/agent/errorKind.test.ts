import { describe, it, expect } from "vitest";
import { classifyAgentError } from "./errorKind";

const err = (message: string, status?: number) => Object.assign(new Error(message), status ? { status } : {});

describe("classifyAgentError", () => {
  it("flags the credit-balance case as billing", () => {
    const c = classifyAgentError(err("400 Your credit balance is too low to access the Anthropic API.", 400));
    expect(c.kind).toBe("billing");
    expect(c.message).toMatch(/credit/i);
  });

  it("flags an invalid/expired key as auth", () => {
    expect(classifyAgentError(err("authentication_error: invalid x-api-key", 401)).kind).toBe("auth");
    expect(classifyAgentError(err("This API key has expired")).kind).toBe("auth");
  });

  it("flags overload / rate limits as overloaded", () => {
    expect(classifyAgentError(err("Overloaded", 529)).kind).toBe("overloaded");
    expect(classifyAgentError(err("rate limit exceeded", 429)).kind).toBe("overloaded");
  });

  it("falls back to a generic error", () => {
    expect(classifyAgentError(err("some other failure", 500)).kind).toBe("error");
    expect(classifyAgentError("weird").kind).toBe("error");
  });
});
