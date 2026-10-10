import { expect, test } from "@playwright/test";
import { signUpRaw } from "./helpers";

test("fresh user is sent to onboarding, saves, and sees values again", async ({ page }) => {
  await signUpRaw(page);
  await expect(page).toHaveURL(/\/onboarding/);
  for (const l of ["Visual", "Text", "Examples", "Summary", "Beginner", "Intermediate", "Advanced"]) {
    await expect(page.getByRole("radio", { name: new RegExp(l) })).toBeVisible();
  }
  await page.getByRole("radio", { name: /Examples/ }).check();
  await page.getByRole("radio", { name: /Advanced/ }).check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/goals$/);
  await page.goto("/onboarding");
  await expect(page.getByRole("radio", { name: /Examples/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: /Advanced/ })).toBeChecked();
});

test("goals redirects to onboarding without prefs", async ({ page }) => {
  await signUpRaw(page);
  await page.goto("/goals");
  await expect(page).toHaveURL(/\/onboarding/);
});
