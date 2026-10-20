import { expect, test, type Page } from "@playwright/test";
import { addLink, mapWithArticle, openLesson, openLessonByUrl } from "./helpers";

const ARTICLE = "http://127.0.0.1:8765/sql-article.html";

// Each test builds a map and streams lessons (some also ingest a second source): allow 90 s.
test.beforeEach(() => test.slow());

const lesson = (page: Page) => page.getByLabel("Lesson", { exact: true });

async function chooseFormat(page: Page, label: string) {
  await expect(page.getByRole("heading", { name: "How do you like to learn?" })).toBeVisible();
  await page.getByRole("radio", { name: new RegExp(`^${label}`) }).check();
  await page.getByRole("button", { name: "Continue" }).click();
}

test("first lesson asks for a format", async ({ page }) => {
  await mapWithArticle(page);
  await openLesson(page, "Joining tables");
  await chooseFormat(page, "Visual");
  await expect(lesson(page).locator("section")).toHaveCount(2, { timeout: 30_000 });
  await expect(lesson(page).getByRole("figure", { name: "Diagram" }).first().locator("svg")).toBeVisible();
  const cite = lesson(page).getByRole("link", { name: /^Source 1:/ }).first();
  await expect(cite).toHaveAttribute("href", new RegExp(`^${ARTICLE.replace(/[.?]/g, "\\$&")}`));
});

test("format chooser closes back to the map", async ({ page }) => {
  await mapWithArticle(page);
  const mapUrl = page.url();
  await openLesson(page, "Joining tables");
  const chooser = page.getByRole("dialog", { name: "How do you like to learn?" });
  await expect(chooser).toBeVisible();
  await expect(chooser.getByRole("radio", { name: /^Visual Diagrams first, with short notes\./ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(mapUrl);
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
  // A gap topic's card offers "Add source" instead of a lesson link.
  await openLessonByUrl(page, "Indexes and query performance");
  await expect(page.getByText("None of your sources cover this topic yet. Add one to get a lesson.")).toBeVisible();
  await expect(page.getByRole("link", { name: /^Search the web for / })).toBeVisible();
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

test("stale lesson can be refreshed", async ({ page }) => {
  await mapWithArticle(page);
  await openLesson(page, "Joining tables");
  await chooseFormat(page, "Visual");
  await expect(lesson(page).locator("section")).toHaveCount(2, { timeout: 30_000 });
  const lessonUrl = page.url();

  // A second source covering the topic makes the lesson out of date.
  await page.getByRole("link", { name: "Back to your map", exact: true }).click();
  await addLink(page, `${ARTICLE}?n=2`);
  const rows = page.getByRole("list", { name: "Your sources" }).getByRole("listitem");
  // Both rows ready means the new source has been matched (and the lesson marked stale).
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Highly relevant", { timeout: 30_000 });
  await expect(rows.nth(1)).toContainText("Highly relevant");

  await page.goto(lessonUrl);
  await expect(page.getByText("New sources available. Refresh lesson?")).toBeVisible();
  // Dismiss hides it for this visit only; the lesson is still out of date.
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByText("New sources available. Refresh lesson?")).toHaveCount(0);
  await expect(lesson(page).locator("section")).toHaveCount(2);
  await page.reload();
  await expect(page.getByText("New sources available. Refresh lesson?")).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("New sources available. Refresh lesson?")).toHaveCount(0);
  await expect(lesson(page).locator("section")).toHaveCount(2, { timeout: 30_000 });
  await page.reload();
  await expect(page.getByText("New sources available. Refresh lesson?")).toHaveCount(0);
});

test("feedback", async ({ page }) => {
  await mapWithArticle(page);
  await openLesson(page, "Joining tables");
  await chooseFormat(page, "Visual");
  await expect(lesson(page).locator("section")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByText("Was this helpful?")).toBeVisible();
  await page.getByRole("button", { name: "Helpful", exact: true }).click();
  await expect(page.getByText("Thanks for the feedback.")).toBeVisible();

  await page.getByRole("group", { name: "Show me this as:" }).getByRole("button", { name: "Summary" }).click();
  await expect(lesson(page).locator("section")).toHaveCount(1, { timeout: 30_000 });
  await page.getByRole("button", { name: "Report an error" }).click();
  await page.getByLabel("What's wrong?").fill("The join example is wrong");
  await page.getByRole("button", { name: "Send report" }).click();
  await expect(page.getByText("Thanks for the feedback.")).toBeVisible();
});

test("guest lesson limit", async ({ page }) => {
  await mapWithArticle(page);
  await openLesson(page, "Joining tables");
  await chooseFormat(page, "Visual");
  await expect(lesson(page).locator("section")).toHaveCount(2, { timeout: 30_000 });
  const subtopicId = page.url().split("/").pop()!;
  // Refreshes always generate (no cached copy), so they use up the guest's 5 lessons.
  for (let i = 0; i < 5; i++) {
    const res = await page.request.post("/api/lessons", { data: { subtopicId, format: "visual", refresh: true } });
    expect(res.status()).toBe(200);
    await res.text();
  }
  await page.getByRole("group", { name: "Show me this as:" }).getByRole("button", { name: "Examples" }).click();
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toHaveText("Sign up free to get more lessons.", { timeout: 30_000 });
  await expect(alert.getByRole("link", { name: "Sign up free" })).toHaveAttribute("href", "/sign-up");
});

for (const width of [320, 375]) {
  test.describe(`switcher at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 } });
    test("format switcher fits without clipping", async ({ page }) => {
      await mapWithArticle(page);
      await openLessonByUrl(page, "Joining tables");
      await chooseFormat(page, "Visual");
      const group = page.getByRole("group", { name: "Show me this as:" });
      await expect(group).toBeVisible({ timeout: 30_000 });
      const { scrollWidth, clientWidth } = await group.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
  });
}
