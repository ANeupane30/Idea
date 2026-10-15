import { expect, test } from "@playwright/test";
import { signUpRaw, START_HEADING } from "./helpers";

test("onboarding saves and shows values again", async ({ page }) => {
  await signUpRaw(page);
  await page.goto("/onboarding");
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

test("goals redirects to the start page without prefs", async ({ page }) => {
  await signUpRaw(page);
  await page.goto("/goals");
  await expect(page.getByRole("heading", { name: START_HEADING })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});
