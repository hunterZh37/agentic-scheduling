import { test, expect } from "@playwright/test";
import { bookFirstSlot } from "./helpers";

// Reschedule + cancel through the attendee's manage link. The signed manage URL
// is normally only in the (staging-stubbed) confirmation email, so we read it
// from the staging-only /api/monitor/last-booking endpoint after booking.
async function manageUrlOfLatest(request: import("@playwright/test").APIRequestContext): Promise<string> {
  const res = await request.get("/api/monitor/last-booking");
  expect(res.ok(), "staging last-booking endpoint should be available").toBeTruthy();
  const { manageUrl } = (await res.json()) as { manageUrl: string };
  expect(manageUrl).toContain("/manage/");
  return manageUrl;
}

test("attendee reschedules then cancels via the manage link", async ({ page, request }) => {
  await bookFirstSlot(page);
  const manageUrl = await manageUrlOfLatest(request);

  // Reschedule → booking page in reschedule mode → pick a new slot → confirm.
  await page.goto(manageUrl);
  await page.getByRole("link", { name: "Reschedule" }).click();
  const slot = page.getByTestId("slot").first();
  await expect(slot).toBeVisible();
  await slot.click();
  await page.getByRole("button", { name: "Confirm new time" }).click();
  await expect(page.getByText("You're rescheduled")).toBeVisible();
  await page.screenshot({ path: "test-results/reschedule.png", fullPage: true });

  // Cancel → manage page → Cancel booking → confirm dialog → cancelled.
  await page.goto(await manageUrlOfLatest(request));
  await page.getByTestId("cancel-booking").click();
  await page.getByRole("button", { name: "Cancel booking" }).click(); // confirm dialog
  await expect(page.getByText("Booking cancelled")).toBeVisible();
  await page.screenshot({ path: "test-results/cancel.png", fullPage: true });
});
