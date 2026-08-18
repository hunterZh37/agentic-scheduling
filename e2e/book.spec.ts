import { test, expect } from "@playwright/test";
import { bookFirstSlot } from "./helpers";

// Core public booking flow: pick a slot on /book, fill the form, submit, and
// land on the confirmation. Against staging (calendar stubbed) this exercises
// the full UI → /api/public/bookings → DB path.
test("visitor books a slot through the public booking page", async ({ page }) => {
  await bookFirstSlot(page);
  await expect(page.getByText("You're booked")).toBeVisible();
  await page.screenshot({ path: "test-results/book-success.png", fullPage: true });
});
