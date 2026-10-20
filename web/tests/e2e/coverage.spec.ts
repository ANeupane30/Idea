import { expect, test, type Page } from "@playwright/test";
import { guestBuildsMap } from "./helpers";

// The fixture article covers SELECT, WHERE and joins, but not indexes.
const ARTICLE = "http://127.0.0.1:8765/sql-article.html";
const EMPTY_STATE = "Add a link, video or PDF to see which topics it covers.";

function topic(page: Page, title: string) {
  return page.getByRole("navigation", { name: "Topic map" }).getByRole("button", { name: new RegExp(`^(\\d+ )?${title}`) });
}

async function addReadyArticle(page: Page) {
  await page.getByLabel("Add a link").fill(ARTICLE);
  await page.getByRole("button", { name: "Add link" }).click();
  const row = page.getByRole("list", { name: "Your sources" }).getByRole("listitem").first();
  await expect(row).toContainText("Highly relevant", { timeout: 30_000 });
  await expect(topic(page, "Joining tables")).toContainText(/Covered|Thin|Gap/);
}

test("no badges before a source is ready", async ({ page }) => {
  await guestBuildsMap(page);
  const nav = page.getByRole("navigation", { name: "Topic map" });
  await expect(nav).not.toContainText(/Covered|Thin|Gap/);
  await expect(page.getByText(EMPTY_STATE)).toBeVisible();
  await expect(page.getByRole("heading", { name: "What to add next" })).toHaveCount(0);
});

test("coverage after a source", async ({ page }) => {
  await guestBuildsMap(page);
  await addReadyArticle(page);
  await expect(topic(page, "Joining tables")).toContainText("Covered");
  await expect(topic(page, "Indexes and query performance")).toContainText("Gap");
  await expect(page.getByText(EMPTY_STATE)).toHaveCount(0);

  await topic(page, "Joining tables").click();
  const panel = page.getByRole("dialog");
  await expect(panel).toContainText("Covered");
  await expect(panel).toContainText("A practical guide to SQL: SELECT, WHERE and JOIN");
  await expect(panel).toContainText("Highly relevant");
  await expect(panel).toContainText("Covers Joining tables.");
});

test("what to add next", async ({ page }) => {
  await guestBuildsMap(page);
  await addReadyArticle(page);
  const section = page.getByRole("region", { name: "What to add next" });
  await expect(section).toBeVisible();
  const items = section.getByRole("listitem");
  expect(await items.count()).toBeLessThanOrEqual(5);
  const indexes = items.filter({ hasText: "Indexes and query performance" });
  await expect(indexes).toContainText("Try searching for: Indexes and query performance SQL");
  const web = indexes.getByRole("link", { name: "Search the web" });
  await expect(web).toHaveAttribute("href", /^https:\/\/www\.google\.com\/search\?q=Indexes(%20|\+)and(%20|\+)query/);
  await expect(indexes.getByRole("link", { name: "Search YouTube" })).toHaveAttribute(
    "href",
    /^https:\/\/www\.youtube\.com\/results\?search_query=Indexes/,
  );
  await expect(items.filter({ hasText: "Joining tables" })).toHaveCount(0);
});

async function expectNoOverlap(page: Page, width: number) {
  const boxes = await page
    .getByRole("navigation", { name: "Topic map" })
    .locator("button[data-topic-id]")
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) {
      const overlap = a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      expect(overlap, `topics overlap at ${width}px`).toBe(false);
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

for (const [width, height] of [
  [375, 812],
  [1024, 768],
  [1440, 900],
] as const) {
  test.describe(`badges at ${width}px`, () => {
    test.use({ viewport: { width, height } });
    test("badges don't overlap or scroll sideways", async ({ page }) => {
      await guestBuildsMap(page);
      await addReadyArticle(page);
      await expectNoOverlap(page, width);
    });
  });
}
