import { expect, test, type Page } from "@playwright/test";
import { guestBuildsMap } from "./helpers";

const ARTICLE = "http://127.0.0.1:8765/sql-article.html";

async function mapWithArticle(page: Page) {
  await guestBuildsMap(page);
  await page.getByLabel("Add a link").fill(ARTICLE);
  await page.getByRole("button", { name: "Add link" }).click();
  await expect(page.getByRole("list", { name: "Your sources" }).getByRole("listitem").first()).toContainText(
    "Highly relevant",
    { timeout: 30_000 },
  );
}

async function openLesson(page: Page, topic: string) {
  await page
    .getByRole("navigation", { name: "Topic map" })
    .getByRole("button", { name: new RegExp(`^(\\d+ )?${topic}`) })
    .click();
  await page.getByRole("dialog").getByRole("link", { name: "Open lesson" }).click();
  // The first visit compiles the route in dev, so allow longer than the default.
  await expect(page).toHaveURL(/\/goals\/[0-9a-f-]{36}\/topics\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1, name: topic })).toBeVisible();
}

const lesson = (page: Page) => page.getByLabel("Lesson", { exact: true });

async function chooseFormat(page: Page, label: string) {
  await expect(page.getByRole("heading", { name: "How do you like to learn?" })).toBeVisible();
  await page.getByRole("radio", { name: new RegExp(`^${label}`) }).check();
  await page.getByRole("button", { name: "Show my lesson" }).click();
}

test("first lesson asks for a format", async ({ page }) => {
  await mapWithArticle(page);
  await openLesson(page, "Joining tables");
  await chooseFormat(page, "Visual");
  await expect(lesson(page).locator("section")).toHaveCount(2, { timeout: 30_000 });
  await expect(lesson(page).getByRole("figure", { name: "Diagram" }).first().locator("svg")).toBeVisible();
  const cite = lesson(page).getByRole("link", { name: "[1]" }).first();
  await expect(cite).toHaveAttribute("href", new RegExp(`^${ARTICLE.replace(/[.?]/g, "\\$&")}`));
});

test("stored lesson loads without writing again", async ({ page }) => {
  await mapWithArticle(page);
  await openLesson(page, "Joining tables");
  await chooseFormat(page, "Visual");
  await expect(lesson(page).locator("section")).toHaveCount(2, { timeout: 30_000 });
  await page.reload();
  await expect(lesson(page).locator("section")).toHaveCount(2);
  await expect(page.getByText("Writing your lesson…")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "How do you like to learn?" })).toHaveCount(0);
});

test("switch format", async ({ page }) => {
  await mapWithArticle(page);
  await openLesson(page, "Joining tables");
  await chooseFormat(page, "Visual");
  await expect(lesson(page).locator("section")).toHaveCount(2, { timeout: 30_000 });
  const switcher = page.getByRole("group", { name: "Show me this as:" });
  await switcher.getByRole("button", { name: "Text" }).click();
  await expect(lesson(page).locator("section")).toHaveCount(3, { timeout: 30_000 });
  await expect(switcher.getByRole("button", { name: "Text" })).toHaveAttribute("aria-pressed", "true");
  await expect(switcher.getByRole("button", { name: "Visual" })).toHaveAttribute("aria-pressed", "false");
  await expect(lesson(page).getByRole("heading", { name: "What a join does" })).toBeVisible();
});

test("unsafe markdown is inert", async ({ page }) => {
  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs++;
    void d.dismiss();
  });
  await mapWithArticle(page);
  await openLesson(page, "Joining tables");
  await chooseFormat(page, "Text");
  await expect(lesson(page).locator("section")).toHaveCount(3, { timeout: 30_000 });
  await expect(lesson(page).locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(lesson(page).locator("img")).toHaveCount(0);
  expect(dialogs).toBe(0);
});

test("topic without sources", async ({ page }) => {
  await mapWithArticle(page);
  await openLesson(page, "Indexes and query performance");
  await expect(page.getByText("None of your sources cover this topic yet. Add one to get a lesson.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Search the web" })).toBeVisible();
});

test("another user's topic is 404", async ({ page, browser }) => {
  await mapWithArticle(page);
  await openLesson(page, "Joining tables");
  const subtopicId = page.url().split("/").pop()!;

  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto("/");
  const res = await otherPage.request.post("/api/lessons", { data: { subtopicId, format: "visual" } });
  expect(res.status()).toBe(404);
  await other.close();
});
