import { expect, test, type Page } from "@playwright/test";
import { addSourceDialog, FIXTURE_ARTICLE, openAddSource, openLesson } from "./helpers";

// Each test builds a map and ingests sources: allow 90 s.
test.beforeEach(() => test.slow());

const sources = (page: Page) => page.getByRole("list", { name: "Your sources" });

async function startWith(page: Page, title: string, links: string[] = []) {
  await page.goto("/");
  await page.getByLabel("Your goal").fill(title);
  if (links.length) {
    await page.getByRole("button", { name: "Where do you want to learn from?" }).click();
    for (const [i, link] of links.entries()) await page.getByRole("textbox", { name: `Link ${i + 1}` }).fill(link);
  }
  await page.getByRole("button", { name: "Build my learning map" }).click();
  await expect(page).toHaveURL(/\/goals\/[0-9a-f-]{36}/);
  // A single short article asks whether to expand before the map is built (stage 2).
  const map = page.getByRole("navigation", { name: "Topic map" });
  const keepSmall = page.getByRole("button", { name: "Keep it small" });
  await expect(map.or(keepSmall)).toBeVisible({ timeout: 45_000 });
  if (await keepSmall.isVisible()) await keepSmall.click();
  await expect(map).toBeVisible({ timeout: 45_000 });
}

test("pick for me adds a source and the first lesson has content", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Your goal").fill("Discoverme SQL joins");
  await page.getByRole("button", { name: "Where do you want to learn from?" }).click();
  await page.getByRole("button", { name: "I don't have sources, pick the best ones for me" }).click();
  await expect(page.getByRole("navigation", { name: "Topic map" })).toBeVisible({ timeout: 30_000 });

  const found = sources(page).getByRole("listitem").filter({ hasText: "A practical guide to SQL" });
  await expect(found).toContainText("Highly relevant", { timeout: 45_000 });
  await expect(page.getByText("Finding sources for your topics…")).toBeHidden({ timeout: 20_000 });

  await openLesson(page, "Joining tables");
  await page.getByRole("button", { name: "Continue" }).click();
  const lesson = page.getByLabel("Lesson", { exact: true });
  await expect(lesson.locator("section").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("None of your sources cover this topic yet.")).toHaveCount(0);
});

test("links on the start form are read and matched", async ({ page }) => {
  await startWith(page, "Learn SQL", [FIXTURE_ARTICLE]);
  const row = sources(page).getByRole("listitem").first();
  await expect(row).toContainText("Highly relevant", { timeout: 45_000 });
});

test("guest with 3 links on the form has used their limit", async ({ page }) => {
  await startWith(page, "Learn SQL", [FIXTURE_ARTICLE, `${FIXTURE_ARTICLE}?b`, `${FIXTURE_ARTICLE}?c`]);
  await expect(sources(page).getByRole("listitem")).toHaveCount(3, { timeout: 30_000 });
  await openAddSource(page);
  const dialog = addSourceDialog(page);
  await dialog.getByLabel("Paste a link to a web page or YouTube video").fill(`${FIXTURE_ARTICLE}?d`);
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog.getByText("Sign up free to add more sources.")).toBeVisible();
});
