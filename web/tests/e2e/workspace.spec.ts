import { expect, test, type Page } from "@playwright/test";
import { guestBuildsMap } from "./helpers";

const panel = (page: Page, name: "Sources" | "Suggestions") => page.getByRole("complementary", { name });
const toggle = (page: Page, name: "Sources" | "Suggestions") =>
  page.getByRole("button", { name: `${name} panel`, exact: true });
const map = (page: Page) => page.getByRole("navigation", { name: "Topic map" });

test.describe("wide screen", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("sources left, map in the middle, suggestions right", async ({ page }) => {
    await guestBuildsMap(page);
    await expect(panel(page, "Sources")).toBeVisible();
    await expect(panel(page, "Suggestions")).toBeVisible();
    const left = (await panel(page, "Sources").boundingBox())!;
    const mid = (await map(page).boundingBox())!;
    const right = (await panel(page, "Suggestions").boundingBox())!;
    expect(left.x + left.width).toBeLessThanOrEqual(mid.x);
    expect(mid.x + mid.width).toBeLessThanOrEqual(right.x);
    await expect(toggle(page, "Sources")).toHaveAttribute("aria-expanded", "true");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
  });

  test("panels toggle and the choice is remembered", async ({ page }) => {
    await guestBuildsMap(page);
    const before = (await map(page).boundingBox())!;
    await toggle(page, "Sources").click();
    await expect(panel(page, "Sources")).toBeHidden();
    await expect(toggle(page, "Sources")).toHaveAttribute("aria-expanded", "false");
    await toggle(page, "Suggestions").click();
    await expect(panel(page, "Suggestions")).toBeHidden();
    const after = (await map(page).boundingBox())!;
    expect(after.x).toBeLessThan(before.x); // the map moves into the freed space

    await page.reload();
    await expect(map(page)).toBeVisible();
    await expect(panel(page, "Sources")).toBeHidden();
    await expect(panel(page, "Suggestions")).toBeHidden();

    await toggle(page, "Sources").click();
    await expect(panel(page, "Sources")).toBeVisible();
    await expect(page.getByLabel("Add a link")).toBeVisible();
  });

  test("topic details open over the map without moving it", async ({ page }) => {
    await guestBuildsMap(page);
    const before = (await map(page).boundingBox())!;
    await map(page).getByRole("button", { name: /^2 / }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const after = (await map(page).boundingBox())!;
    expect(after.width).toBe(before.width);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("panels start closed and open as drawers", async ({ page }) => {
    await guestBuildsMap(page);
    await expect(panel(page, "Sources")).toBeHidden();
    await expect(panel(page, "Suggestions")).toBeHidden();
    await toggle(page, "Sources").click();
    await expect(panel(page, "Sources")).toBeVisible();
    await expect(page.getByLabel("Add a link")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel(page, "Sources")).toBeHidden();
    await toggle(page, "Suggestions").click();
    await expect(panel(page, "Suggestions")).toBeVisible();
    await panel(page, "Suggestions").getByRole("button", { name: "Close" }).click();
    await expect(panel(page, "Suggestions")).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });
});
