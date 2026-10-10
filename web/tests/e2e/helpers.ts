import { expect, type Page } from "@playwright/test";

export const TEST_PASSWORD = "correct-horse-battery";

/** Signs up a brand-new user and returns its email. Ends on /goals. */
export async function signUpFresh(page: Page): Promise<string> {
  const email = `e2e+${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await page.goto("/sign-up");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page).toHaveURL(/\/goals/);
  return email;
}
