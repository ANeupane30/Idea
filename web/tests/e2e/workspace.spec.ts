import { expect, test, type Page } from "@playwright/test";
import { guestBuildsMap } from "./helpers";

const map = (page: Page) => page.getByRole("navigation", { name: "Topic map" });
const noSideScroll = async (page: Page, width: number) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

test.describe("wide screen", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("map on the left, sources and suggestions on the right", async ({ page }) => {
    await guestBuildsMap(page);
    const mapBox = (await map(page).boundingBox())!;
    const sources = (await page.getByRole("region", { name: "Sources" }).boundingBox())!;
    expect(mapBox.x).toBeLessThan(sources.x);
    expect(sources.x).toBeGreaterThan(1440 / 2);
    // Every topic card is fully visible: the map isn't squeezed into a scroll box.
    const { scrollWidth, clientWidth } = await map(page).evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    await noSideScroll(page, 1440);
  });

  test("long titles wrap", async ({ page }) => {
    await guestBuildsMap(page, `Learn ${"very ".repeat(22)}long things`.slice(0, 120));
    await noSideScroll(page, 1440);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("columns stack under the map", async ({ page }) => {
    await guestBuildsMap(page);
    const mapBox = (await map(page).boundingBox())!;
    const sources = (await page.getByRole("region", { name: "Sources" }).boundingBox())!;
    expect(sources.y).toBeGreaterThanOrEqual(mapBox.y + mapBox.height);
    await noSideScroll(page, 375);
  });

  test("long titles wrap", async ({ page }) => {
    await guestBuildsMap(page, `Learn ${"very ".repeat(22)}long things`.slice(0, 120));
    await noSideScroll(page, 375);
  });
});

test("archived goal has no add controls", async ({ page }) => {
  await guestBuildsMap(page);
  const url = page.url();
  await page.goto("/goals");
  await page.getByRole("region", { name: "Active" }).getByRole("button", { name: "Archive" }).click();
  await expect(page.getByRole("region", { name: "Archived" }).getByText("Learn SQL")).toBeVisible();
  await page.goto(url);
  await expect(map(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Add source" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Sources" })).toBeVisible();
});
