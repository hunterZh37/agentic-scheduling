import { test, expect } from "@playwright/test";

// Visitor books via the AI agent chat (/assistant → /api/agent/requester). The
// agent gathers a time + the visitor's details and books. Against staging the
// booking write is stubbed. This spec is intentionally lenient about the exact
// conversation (the model phrases things freely) — it drives a few turns and
// asserts the agent reaches a booked/confirmed state.
test("visitor books via the AI agent chat", async ({ page }) => {
  await page.goto("/assistant");
  const input = page.getByPlaceholder(/Book 30 min|Thinking/);
  await expect(input).toBeVisible();

  const say = async (text: string) => {
    await input.fill(text);
    await page.getByRole("button", { name: "Send" }).click();
    // Wait for the agent to stop "typing".
    await expect(page.getByLabel("Assistant is typing")).toHaveCount(0, { timeout: 60_000 });
  };

  await say("Book a 30 minute meeting. I'm free any weekday afternoon next week. My name is E2E Monitor and email e2e-monitor@example.com, timezone America/New_York.");
  // Give the agent a nudge to confirm/book if it asked to pick.
  await say("Yes, the first option works — please book it.");

  await expect(
    page.getByText(/booked|confirmed|see you|scheduled/i).first(),
    "expected the agent to confirm a booking"
  ).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: "test-results/agent-book.png", fullPage: true });
});
