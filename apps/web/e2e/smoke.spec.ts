import { expect, test } from "@playwright/test";

test("home renders header, search box, and TM attribution", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: /TicketRhino/ })).toBeVisible();
  await expect(page.getByPlaceholder(/Search artist/)).toBeVisible();
  await expect(page.getByText(/Event data by/)).toBeVisible();
});

test("empty watchlist shows CTA to trending", async ({ page }) => {
  await page.goto("/watchlist");
  await expect(page.getByText(/Nothing tracked yet/)).toBeVisible();
});

test("event page for unknown id shows not-found state, never hard-fails", async ({ page }) => {
  await page.goto("/event/999999");
  await expect(page.getByText(/Event not found/)).toBeVisible();
});

test("anon cookie minted on first visit", async ({ page, context }) => {
  await page.goto("/");
  const cookie = (await context.cookies()).find((c) => c.name === "rhino_anon");
  expect(cookie?.value).toMatch(/^[0-9a-f-]{36}$/);
});

test.describe("live TM path", () => {
  test.skip(!process.env.TM_API_KEY, "needs TM_API_KEY");
  test("search renders results and event page shows PRIMARY row", async ({ page }) => {
    await page.goto("/search?q=concert");
    const first = page.locator("a[href^='/event/']").first();
    await expect(first).toBeVisible();
    await first.click();
    await expect(page.getByText("PRIMARY · TICKETMASTER")).toBeVisible();
    await expect(page.getByText("RESALE · SEATGEEK")).toBeVisible();
  });
});
