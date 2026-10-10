import { expect, type Page } from "@playwright/test";

export const TEST_PASSWORD = "correct-horse-battery";

/** Signs up a brand-new user without onboarding. Ends on /onboarding. Returns the email. */
export async function signUpRaw(page: Page): Promise<string> {
  const email = `e2e+${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await page.goto("/sign-up");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page).toHaveURL(/\/(goals|onboarding)/);
  return email;
}

/** Signs up a brand-new user, completes onboarding, and returns its email. Ends on /goals. */
export async function signUpFresh(page: Page): Promise<string> {
  const email = await signUpRaw(page);
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/goals$/);
  return email;
}
