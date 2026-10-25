import { expect, test, type Page } from "@playwright/test";
import { addSourceDialog, FIXTURE_ARTICLE } from "./helpers";

// Each test reads sources and builds a map: allow 90 s.
test.beforeEach(() => test.slow());

const SHORT = "http://127.0.0.1:8765/short-article.html";
const SIGN_IN_WALL = "http://127.0.0.1:8765/sign-in-wall.html";
const PAYWALLED = "We can't read this page, it needs a login. Paste the course's syllabus or table of contents instead.";
const QUESTION = "This looks like a single article rather than a full curriculum. Expand this topic with related guides?";

const map = (page: Page) => page.getByRole("navigation", { name: "Topic map" });
const sources = (page: Page) => page.getByRole("list", { name: "Your sources" });

async function start(page: Page, { links = [], outline }: { links?: string[]; outline?: string }) {
  await page.goto("/");
  await page.getByLabel("Your goal").fill("Learn SQL");
  await page.getByRole("button", { name: "Where do you want to learn from?" }).click();
  for (const [i, link] of links.entries()) await page.getByRole("textbox", { name: `Link ${i + 1}` }).fill(link);
  if (outline) {
    await page.getByRole("tab", { name: "Paste an outline" }).click();
    await page.getByRole("textbox", { name: "Your outline" }).fill(outline);
  }
  await page.getByRole("button", { name: "Build my learning map" }).click();
  await expect(page).toHaveURL(/\/goals\/[0-9a-f-]{36}/);
}

test("pasted outline gives a map that follows it", async ({ page }) => {
  await start(page, { outline: "1. Tables\n2. Joins\n3. Indexes" });
  await expect(map(page)).toBeVisible({ timeout: 45_000 });
  const tops = map(page).getByRole("button", { name: /^\d+ / });
  await expect(tops).toHaveText([/^1 Tables/, /^2 Joins/, /^3 Indexes/]);
  await tops.first().click();
  await expect(page.getByRole("dialog").getByText(/^Main reference: Your outline/)).toBeVisible();
});

test("one short link asks to expand; keeping it small builds the map", async ({ page }) => {
  await start(page, { links: [SHORT] });
  await expect(page.getByText(QUESTION)).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Keep it small" }).click();
  await expect(map(page)).toBeVisible({ timeout: 45_000 });
});

test("one short link asks to expand; expanding builds a full map", async ({ page }) => {
  await start(page, { links: [SHORT] });
  await expect(page.getByText(QUESTION)).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Expand" }).click();
  await expect(map(page)).toBeVisible({ timeout: 45_000 });
  await expect(map(page).getByRole("button", { name: /^\d+ / })).toHaveCount(6);
});

test("a paywalled link shows the paste-outline message", async ({ page }) => {
  await start(page, { links: [SIGN_IN_WALL] });
  await expect(map(page)).toBeVisible({ timeout: 45_000 });
  const failed = sources(page).getByRole("listitem").filter({ hasText: PAYWALLED });
  await expect(failed).toBeVisible();
  await failed.getByRole("button", { name: "Paste an outline" }).click();
  const dialog = addSourceDialog(page);
  await expect(dialog.getByRole("tab", { name: "Paste an outline" })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("textbox", { name: "Your outline" })).toBeVisible();
});

test("one of two links fails and the map is still built", async ({ page }) => {
  await start(page, { links: [SIGN_IN_WALL, FIXTURE_ARTICLE] });
  // Reading carries on with the link that worked; a single article asks whether to expand.
  await expect(page.getByText(QUESTION)).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Keep it small" }).click();
  await expect(map(page)).toBeVisible({ timeout: 45_000 });
  await expect(sources(page).getByRole("listitem").filter({ hasText: PAYWALLED })).toBeVisible();
  await expect(sources(page).getByRole("listitem").filter({ hasText: "A practical guide to SQL" })).toContainText(
    /Highly relevant|Partly relevant/,
    { timeout: 45_000 },
  );
});
