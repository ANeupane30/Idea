import { expect, test, type Page } from "@playwright/test";
import { signUpFresh } from "./helpers";

const SQL_TOPICS = [
  "What databases and SQL are",
  "Querying with SELECT",
  "Aggregation and grouping",
  "Joining tables",
  "Modifying data and schemas",
  "Indexes and query performance",
];

async function addGoal(page: Page, title: string) {
  await page.goto("/goals");
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Create goal" }).click();
  await expect(page).toHaveURL(/\/goals\/[0-9a-f-]{36}/);
}

test("map appears after creation", async ({ page }) => {
  await signUpFresh(page);
  await addGoal(page, "Learn SQL");
  for (const t of SQL_TOPICS) {
    await expect(page.getByText(t, { exact: true })).toBeVisible({ timeout: 15_000 });
  }
});

test("clarifying question flow", async ({ page }) => {
  await signUpFresh(page);
  await addGoal(page, "SQL [clarify]");
  await expect(page.getByText("What do you want to use SQL for?")).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("Your answer").fill("data analysis");
  await page.getByRole("button", { name: "Submit answer" }).click();
  await expect(page.getByText(SQL_TOPICS[0], { exact: true })).toBeVisible({ timeout: 15_000 });
});

test("other users goal is 404", async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await signUpFresh(a);
  await addGoal(a, "Private goal");
  const url = a.url();
  await signUpFresh(b);
  await b.goto(url);
  await expect(b.getByText("This page could not be found.")).toBeVisible();
  await ctxA.close();
  await ctxB.close();
});

async function readyMap(page: Page) {
  await signUpFresh(page);
  await addGoal(page, "Learn SQL");
  await expect(page.getByText(SQL_TOPICS[5], { exact: true })).toBeVisible({ timeout: 15_000 });
}

/** Titles of the top-level rows, in order. */
async function topTitles(page: Page) {
  return page.locator('[data-testid="topic-row"][data-level="0"] > div > [data-testid="topic-title"]').allTextContents();
}

test("rename persists", async ({ page }) => {
  await readyMap(page);
  await page.getByRole("button", { name: `Rename: ${SQL_TOPICS[0]}` }).click();
  const input = page.getByLabel(`Title for ${SQL_TOPICS[0]}`);
  await input.fill("SQL foundations");
  await input.press("Enter");
  await expect(page.getByText("SQL foundations", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("SQL foundations", { exact: true })).toBeVisible();
});

test("blank rename rejected", async ({ page }) => {
  await readyMap(page);
  await page.getByRole("button", { name: `Rename: ${SQL_TOPICS[0]}` }).click();
  const input = page.getByLabel(`Title for ${SQL_TOPICS[0]}`);
  await input.fill("   ");
  await input.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "Title can't be empty." })).toBeVisible();
  await input.press("Escape");
  await expect(page.getByText(SQL_TOPICS[0], { exact: true })).toBeVisible();
});

test("reorder", async ({ page }) => {
  await readyMap(page);
  await page.getByRole("button", { name: `Move down: ${SQL_TOPICS[0]}` }).click();
  await expect.poll(() => topTitles(page)).toEqual([SQL_TOPICS[1], SQL_TOPICS[0], ...SQL_TOPICS.slice(2)]);
  await page.reload();
  expect(await topTitles(page)).toEqual([SQL_TOPICS[1], SQL_TOPICS[0], ...SQL_TOPICS.slice(2)]);
});

test("indent and outdent", async ({ page }) => {
  await readyMap(page);
  const joining = SQL_TOPICS[3];
  await page.getByRole("button", { name: `Indent: ${joining}` }).click();
  await expect(
    page.locator('[data-testid="topic-row"][data-level="1"]').filter({ hasText: joining }),
  ).toBeVisible();
  await expect.poll(() => topTitles(page)).toEqual(SQL_TOPICS.filter((t) => t !== joining));
  await page.getByRole("button", { name: `Outdent: ${joining}` }).click();
  await expect.poll(() => topTitles(page)).toEqual(SQL_TOPICS);
});

test("cannot nest a parent", async ({ page }) => {
  await readyMap(page);
  await expect(page.getByRole("button", { name: `Indent: ${SQL_TOPICS[2]}` })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Indent: ${SQL_TOPICS[3]}` })).toHaveCount(1);
});

test("add and delete", async ({ page }) => {
  await readyMap(page);
  await page.getByRole("button", { name: "Add subtopic" }).click();
  await page.getByLabel("New subtopic title").fill("Window functions");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect.poll(() => topTitles(page)).toEqual([...SQL_TOPICS, "Window functions"]);

  await page.getByRole("button", { name: `Delete: ${SQL_TOPICS[1]}` }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(`Delete ${SQL_TOPICS[1]} and its 2 subtopics?`);
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Filtering with WHERE", { exact: true })).toHaveCount(0);
  await expect(page.getByText(SQL_TOPICS[1], { exact: true })).toHaveCount(0);
});
