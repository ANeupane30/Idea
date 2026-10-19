import { expect, test, type Page } from "@playwright/test";
import { guestBuildsMap, newEmail, signUpFresh, START_HEADING, TEST_PASSWORD, userId } from "./helpers";
import fixture from "../../../worker/tests/fixtures/fake_llm/topic_map.json";

const GUEST_LIMIT = "Sign up free to save your progress and add more goals.";
const SIGN_IN_WARNING = "Signing in to another account won't keep your guest goal.";
const MAIN_TOPICS = fixture.subtopics.map((t) => t.title);

async function convertGuest(page: Page, email: string) {
  await page.getByRole("link", { name: "Save your progress" }).click();
  await expect(page).toHaveURL(/\/sign-up$/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign up" }).click();
}

test("visitor lands on start page", async ({ page }) => {
  const visited: string[] = [];
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) visited.push(f.url());
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: START_HEADING })).toBeVisible();
  await expect(page.getByLabel("Your goal")).toHaveAttribute(
    "placeholder",
    "Learn the basics of personal finance",
  );
  const level = page.getByRole("group", { name: "Your level" });
  await expect(level.getByRole("radio", { name: "Beginner" })).toBeChecked();
  await expect(level.getByRole("radio", { name: "Intermediate" })).not.toBeChecked();
  await expect(level.getByRole("radio", { name: "Advanced" })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Build my learning map" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
  expect(visited.some((u) => /\/sign-(in|up)/.test(u))).toBe(false);
});

test("guest builds a map", async ({ page }) => {
  await guestBuildsMap(page);
  const nav = page.getByRole("navigation", { name: "Topic map" });
  for (const t of MAIN_TOPICS) await expect(nav.getByText(t, { exact: true })).toBeVisible();
  await expect(page.getByText("Built for: Beginner", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Save your progress" })).toHaveAttribute("href", "/sign-up");
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in");
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
});

test("guest second goal prompts signup", async ({ page }) => {
  await guestBuildsMap(page);
  await page.goto("/goals");
  await page.getByLabel("Title").fill("Second goal");
  await page.getByRole("button", { name: "Create goal" }).click();
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toHaveText(GUEST_LIMIT);
  await expect(alert.getByRole("link", { name: "Sign up free" })).toHaveAttribute("href", "/sign-up");
});

test("guest signup keeps the map", async ({ page }) => {
  await guestBuildsMap(page);
  const guestId = await userId(page);
  await convertGuest(page, newEmail());
  await expect(page).toHaveURL(/\/goals$/);
  await expect(page.getByRole("listitem").filter({ hasText: "Learn SQL" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Save your progress" })).toHaveCount(0);
  expect(await userId(page)).toBe(guestId);

  await page.getByLabel("Title").fill("Second goal");
  await page.getByRole("button", { name: "Create goal" }).click();
  await expect(page).toHaveURL(/\/goals\/[0-9a-f-]{36}/);
  await expect(page.getByRole("heading", { level: 1, name: "Second goal" })).toBeVisible();
});

test("one guest session per browser", async ({ page }) => {
  await page.goto("/");
  const first = await userId(page);
  expect(first).toMatch(/^[0-9a-f-]{36}$/);
  await page.reload();
  expect(await userId(page)).toBe(first);
  await page.goto("/sign-in");
  await page.goto("/");
  expect(await userId(page)).toBe(first);
});

test("sign in from guest", async ({ page, browser }) => {
  // An existing account with its own goal, made in another browser.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  const email = await signUpFresh(otherPage);
  await otherPage.getByLabel("Title").fill("Account goal");
  await otherPage.getByRole("button", { name: "Create goal" }).click();
  await expect(otherPage).toHaveURL(/\/goals\/[0-9a-f-]{36}/);
  await other.close();

  // No guest goal yet: no warning.
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByText(SIGN_IN_WARNING)).toHaveCount(0);

  await guestBuildsMap(page, "Guest goal");
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByText(SIGN_IN_WARNING)).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/goals$/);
  await expect(page.getByRole("listitem").filter({ hasText: "Account goal" })).toBeVisible();
  await expect(page.getByRole("main").getByText("Guest goal")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("guest signup duplicate email", async ({ page, browser }) => {
  const other = await browser.newContext();
  const email = await signUpFresh(await other.newPage());
  await other.close();

  await guestBuildsMap(page);
  const guestId = await userId(page);
  await convertGuest(page, email);
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "An account with this email already exists. Try signing in.",
  );

  await page.goto("/goals");
  await expect(page.getByRole("listitem").filter({ hasText: "Learn SQL" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Save your progress" })).toBeVisible();
  expect(await userId(page)).toBe(guestId);
});

test("sign out returns to a fresh guest", async ({ page }) => {
  await guestBuildsMap(page);
  await convertGuest(page, newEmail());
  await expect(page).toHaveURL(/\/goals$/);
  const accountId = await userId(page);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: START_HEADING })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: START_HEADING })).toBeVisible();
  await expect(page.getByRole("link", { name: "Save your progress" })).toBeVisible();
  const guestId = await userId(page);
  expect(guestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(guestId).not.toBe(accountId);

  // The fresh guest has no prefs, so /goals sends them back to the start page.
  await page.goto("/goals");
  await expect(page.getByRole("heading", { name: START_HEADING })).toBeVisible();
  await expect(page.getByRole("main").getByText("Learn SQL")).toHaveCount(0);
});
