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
