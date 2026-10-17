import { expect, test, type Page } from "@playwright/test";
import { expectNoOverlap, guestBuildsMap, mapWithArticle, openLesson } from "./helpers";

const RIGHT = "Joins combine rows from related tables.";

// Each test builds a map, writes a lesson and runs a quiz: allow more than the 30 s default.
test.beforeEach(() => test.slow());
const WRONG = "Joins delete rows.";

/** Article ready, Visual lesson for "Joining tables", then a topic quiz answered in order. */
async function quizJoins(page: Page, rightOrWrong: boolean[]) {
  await mapWithArticle(page);
  await openLesson(page, "Joining tables");
  await page.getByRole("radio", { name: /^Visual/ }).check();
  await page.getByRole("button", { name: "Show my lesson" }).click();
  await expect(page.getByLabel("Lesson", { exact: true }).locator("section")).toHaveCount(2, { timeout: 30_000 });
  await page.getByRole("link", { name: "Quiz me on this" }).click();
  await expect(page.getByText("Question 1 of 5")).toBeVisible({ timeout: 30_000 });
  for (const [i, right] of rightOrWrong.entries()) {
    // Wait for this question, so the old (answered) one isn't still on screen.
    await expect(page.getByText(`Question ${i + 1} of 5`)).toBeVisible();
    await page.getByRole("radio", { name: right ? RIGHT : WRONG, exact: true }).check();
    await page.getByRole("button", { name: "Check answer" }).click();
    await page.getByRole("button", { name: i < 4 ? "Next question" : "See results" }).click();
  }
  await expect(page.getByRole("heading", { name: "Your results" })).toBeVisible();
  await page.getByRole("link", { name: "← Back to your map" }).click();
  await expect(page.getByRole("navigation", { name: "Topic map" })).toBeVisible({ timeout: 30_000 });
}

test("mastery bar after a quiz", async ({ page }) => {
  await quizJoins(page, [false, false, true, true, true]);
  const node = page.getByRole("navigation", { name: "Topic map" }).getByRole("button", { name: /^4 Joining tables/ });
  await expect(node.getByRole("img", { name: /^Mastery: (Weak|Developing)$/ })).toBeVisible();
  const next = page.getByRole("region", { name: "What to study next" });
  await expect(next.getByRole("link", { name: "Joining tables" })).toBeVisible();
  await expect(next.getByRole("link", { name: "Start a review quiz" })).toBeVisible();
});

test("review quiz", async ({ page }) => {
  await quizJoins(page, [true, true, true, false, true]);
  await page.getByRole("link", { name: "Start a review quiz" }).click();
  await expect(page.getByText("Question 1 of 10")).toBeVisible({ timeout: 30_000 });
  for (let n = 1; n <= 10; n++) {
    await expect(page.getByText(`Question ${n} of 10`)).toBeVisible();
    await page.getByRole("radio", { name: RIGHT, exact: true }).check();
    await page.getByRole("button", { name: "Check answer" }).click();
    await page.getByRole("button", { name: n < 10 ? "Next question" : "See results" }).click();
  }
  await expect(page.getByRole("heading", { name: "Your results" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Joining tables" })).toContainText("10 of 10");
});

test("review without practice", async ({ page }) => {
  await guestBuildsMap(page);
  await page.goto(`${page.url()}/review`);
  await expect(page.getByText("Take a topic quiz first, then come back for a review.")).toBeVisible({ timeout: 30_000 });
});

for (const [width, height] of [
  [375, 812],
  [1024, 768],
  [1440, 900],
] as const) {
  test.describe(`mastery bars at ${width}px`, () => {
    test.use({ viewport: { width, height } });
    test("bars don't overlap or scroll sideways", async ({ page }) => {
      await quizJoins(page, [true, false, true, true, false]);
      await expect(page.getByRole("img", { name: /^Mastery: / }).first()).toBeVisible();
      await expectNoOverlap(page, width);
    });
  });
}
