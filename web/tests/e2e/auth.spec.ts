import { expect, test } from "@playwright/test";
import { signUpFresh, START_HEADING, TEST_PASSWORD } from "./helpers";

test("sign up then sign out then sign in", async ({ page }) => {
  const email = await signUpFresh(page);
  await expect(page).not.toHaveURL(/\/sign-up/);
  await expect(page.getByRole("heading", { name: "Your goals" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  // Signed out: back on the start page as a fresh guest, never forced to /sign-in.
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/goals");
  await expect(page.getByRole("heading", { name: START_HEADING })).toBeVisible();
  await expect(page).not.toHaveURL(/\/sign-in/);

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/goals/);
});

test("wrong password shows message", async ({ page }) => {
  const email = await signUpFresh(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Email or password is incorrect.");
});

test("short password is rejected with plain copy", async ({ page }) => {
  await page.goto("/sign-up");
  await page.getByLabel("Email").fill(`e2e+short-${Date.now()}@example.com`);
  await page.getByLabel("Password").fill("short");
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Password must be at least 8 characters.");
});
