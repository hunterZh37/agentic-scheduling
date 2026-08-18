import { type Page, expect } from "@playwright/test";

// Shared helpers for the e2e flows. All assume a STAGING deploy with
// E2E_STUB_CALENDAR=true (calendar writes stubbed, notifications silenced).

const TEST_ATTENDEE = { name: "E2E Monitor", email: "e2e-monitor@example.com" };

/// Drive the public booking UI to book the first available slot. Returns the
/// manage URL (from the success screen) so a follow-up can reschedule/cancel.
/// Steps through the default duration; picks the next day that has open slots.
export async function bookFirstSlot(page: Page): Promise<void> {
  await page.goto("/book");

  // Slots load for the selected day; if none, advance days until some appear.
  let slot = page.getByTestId("slot").first();
  for (let tries = 0; tries < 10; tries++) {
    if (await slot.count()) break;
    // Next month / next day control — advance and re-check.
    const next = page.getByRole("button", { name: "›" });
    if (await next.count()) await next.click();
    await page.waitForTimeout(800);
    slot = page.getByTestId("slot").first();
  }
  await expect(slot, "expected at least one open slot").toBeVisible();
  await slot.click();

  await page.getByRole("button", { name: "Next" }).click();
  await page.getByTestId("booking-name").fill(TEST_ATTENDEE.name);
  await page.getByTestId("booking-email").fill(TEST_ATTENDEE.email);
  await page.getByRole("button", { name: "Confirm booking" }).click();

  // Success screen.
  await expect(page.getByText("You're booked")).toBeVisible();
}
