import { expect, test, type Page } from "@playwright/test";
import { mapWithArticle, openLesson, openLessonByUrl } from "./helpers";

const ARTICLE = "http://127.0.0.1:8765/sql-article.html";
// The fake question bank always has this as the correct option.
const RIGHT = "Joins combine rows from related tables.";

// Each test builds a map, writes a lesson and runs a quiz: allow more than the 30 s default.
test.beforeEach(() => test.slow());
const WRONG = "Joins delete rows.";

/** Guest with the article ready and a Visual lesson open for "Joining tables", then the topic quiz. */
async function startTopicQuiz(page: Page) {
  await mapWithArticle(page);
  await openLesson(page, "Joining tables");
  await page.getByRole("radio", { name: /^Visual/ }).check();
  await page.getByRole("button", { name: "Show my lesson" }).click();
  await expect(page.getByLabel("Lesson", { exact: true }).locator("section")).toHaveCount(2, { timeout: 30_000 });
  await page.getByRole("link", { name: "Quiz me on this" }).click();
  await expect(page.getByText("Question 1 of 5")).toBeVisible({ timeout: 30_000 });
}

async function answer(page: Page, option: string) {
  await page.getByRole("radio", { name: option, exact: true }).check();
  await page.getByRole("button", { name: "Check answer" }).click();
}

test("topic quiz", async ({ page }) => {
  await startTopicQuiz(page);
  for (let n = 1; n <= 5; n++) {
    await expect(page.getByText(`Question ${n} of 5`)).toBeVisible();
    await answer(page, RIGHT);
    await expect(page.getByText("Correct!")).toBeVisible();
    await page.getByRole("button", { name: n < 5 ? "Next question" : "See results" }).click();
  }
  await expect(page.getByRole("heading", { name: "Your results" })).toBeVisible();
  const row = page.getByRole("listitem").filter({ hasText: "Joining tables" });
  await expect(row).toContainText(/Developing|Strong/);
  await expect(row).toContainText("5 of 5");
});

test("wrong answer shows the explanation and source", async ({ page }) => {
  await startTopicQuiz(page);
  await answer(page, WRONG);
  await expect(page.getByText(`Not quite. The answer is: ${RIGHT}`)).toBeVisible();
  await expect(page.getByText("The sources say joins combine rows from related tables.")).toBeVisible();
  const source = page.getByRole("link", { name: /\[1\]/ });
  await expect(source).toHaveAttribute("href", new RegExp(`^${ARTICLE.replace(/[.?]/g, "\\$&")}`));
});

test("flag", async ({ page }) => {
  await startTopicQuiz(page);
  await answer(page, RIGHT);
  await page.getByRole("button", { name: "Flag this question" }).click();
  await expect(page.getByText("Thanks. This question won't be shown to you again.")).toBeVisible();
});

test("double click answers once", async ({ page }) => {
  await startTopicQuiz(page);
  await page.getByRole("radio", { name: RIGHT, exact: true }).check();
  await page.getByRole("button", { name: "Check answer" }).dblclick();
  await expect(page.getByText("Correct!")).toHaveCount(1);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Next question" }).click();
  await expect(page.getByText("Question 2 of 5")).toBeVisible();
});

test("topic without sources", async ({ page }) => {
  await mapWithArticle(page);
  await openLessonByUrl(page, "Indexes and query performance");
  await page.goto(`${page.url()}/quiz`);
  await expect(page.getByText("Add a source that covers this topic to get questions.")).toBeVisible();
});
