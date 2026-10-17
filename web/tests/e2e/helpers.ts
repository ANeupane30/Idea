import { expect, type Page } from "@playwright/test";

export const TEST_PASSWORD = "correct-horse-battery";
export const START_HEADING = "What do you want to learn?";

export function newEmail(): string {
  return `e2e+${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/** The current user's id, from the site header (guests included). */
export async function userId(page: Page): Promise<string | null> {
  // Visible only: Next keeps recently visited routes mounted but hidden.
  return page.locator("header[data-user-id]:visible").getAttribute("data-user-id");
}

/**
 * Signs up a brand-new user without setting preferences. Opening /sign-up makes
 * a guest, and signing up converts it. Ends on the start page. Returns the email.
 */
export async function signUpRaw(page: Page): Promise<string> {
  const email = newEmail();
  await page.goto("/sign-up");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByRole("heading", { name: START_HEADING })).toBeVisible();
  return email;
}

/** Signs up a brand-new user, saves default preferences, and returns its email. Ends on /goals. */
export async function signUpFresh(page: Page): Promise<string> {
  const email = await signUpRaw(page);
  await page.goto("/onboarding");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/goals$/);
  return email;
}

/** As a guest on the start page, builds a map and waits until it is ready. */
export async function guestBuildsMap(page: Page, title = "Learn SQL") {
  await page.goto("/");
  await page.getByLabel("Your goal").fill(title);
  await page.getByRole("button", { name: "Build my learning map" }).click();
  await expect(page).toHaveURL(/\/goals\/[0-9a-f-]{36}/);
  await expect(page.getByRole("navigation", { name: "Topic map" })).toBeVisible({ timeout: 30_000 });
}

const FIXTURE_ARTICLE = "http://127.0.0.1:8765/sql-article.html";

/** Guest map with the fixture article added and matched. */
export async function mapWithArticle(page: Page) {
  await guestBuildsMap(page);
  await page.getByLabel("Add a link").fill(FIXTURE_ARTICLE);
  await page.getByRole("button", { name: "Add link" }).click();
  await expect(page.getByRole("list", { name: "Your sources" }).getByRole("listitem").first()).toContainText(
    "Highly relevant",
    { timeout: 30_000 },
  );
}

export async function openLesson(page: Page, topic: string) {
  await page
    .getByRole("navigation", { name: "Topic map" })
    .getByRole("button", { name: new RegExp(`^(\\d+ )?${topic}`) })
    .click();
  await page.getByRole("dialog").getByRole("link", { name: "Open lesson" }).click();
  // The first visit compiles the route in dev, so allow longer than the default.
  await expect(page).toHaveURL(/\/goals\/[0-9a-f-]{36}\/topics\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1, name: topic })).toBeVisible();
}
