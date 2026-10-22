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
    await expect(page.getByText(t, { exact: true })).toBeVisible({ timeout: 30_000 });
  }
});

test("clarifying question flow", async ({ page }) => {
  await signUpFresh(page);
  await addGoal(page, "SQL [clarify]");
  await expect(page.getByText("What do you want to use SQL for?")).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Your answer").fill("data analysis");
  await page.getByRole("button", { name: "Submit answer" }).click();
  await expect(page.getByText(SQL_TOPICS[0], { exact: true })).toBeVisible({ timeout: 30_000 });
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
