import { expect, test } from "@playwright/test";
import { guestBuildsMap } from "./helpers";

const rail = (page: import("@playwright/test").Page) => page.getByRole("navigation", { name: "Main" });

test("rail marks the current page", async ({ page }) => {
  await guestBuildsMap(page);
  await expect(rail(page).getByRole("link", { name: "Goals" })).toHaveAttribute("aria-current", "page");
  await rail(page).getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(/\/goals\/[0-9a-f-]{36}\/review$/);
  await expect(rail(page).getByRole("link", { name: "Review" })).toHaveAttribute("aria-current", "page");
  await expect(rail(page).getByRole("link", { name: "Goals" })).not.toHaveAttribute("aria-current", "page");
});

test("guest account actions", async ({ page }) => {
  await guestBuildsMap(page);
  await expect(rail(page).getByRole("link", { name: "Save your progress" })).toHaveAttribute("href", "/sign-up");
  await expect(rail(page).getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in");
});

test.describe("phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test("rail is a bottom bar", async ({ page }) => {
    await guestBuildsMap(page);
    const box = (await rail(page).boundingBox())!;
    expect(Math.round(box.y + box.height)).toBe(812);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });
});
