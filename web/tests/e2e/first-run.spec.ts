import { expect, test } from "@playwright/test";
import { signUpRaw } from "./helpers";

test("first run: sign up, onboard, create goal, map persists", async ({ page }) => {
  await signUpRaw(page);
  await page.goto("/onboarding");
  await page.getByRole("radio", { name: /Visual/ }).check();
  await page.getByRole("radio", { name: /Beginner/ }).check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/goals$/);

  await page.getByLabel("Title").fill("Learn SQL");
  await page.getByRole("button", { name: "Create goal" }).click();
  await expect(page).toHaveURL(/\/goals\/[0-9a-f-]{36}/);
  const first = "What databases and SQL are";
  await expect(page.getByText(first, { exact: true })).toBeVisible({ timeout: 30_000 });

  await page.reload();
  await expect(page.getByText(first, { exact: true })).toBeVisible();
  await expect(page.getByText("Indexes and query performance", { exact: true })).toBeVisible();

  await page.goto("/goals");
  const row = page.getByRole("listitem").filter({ hasText: "Learn SQL" });
  await expect(row.getByText("Ready")).toBeVisible();
});

test("start page matches the design", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "What do you want to learn?" })).toBeVisible();
  await expect(page.getByLabel("Your goal")).toHaveAttribute("placeholder", "Learn the basics of personal finance");
  await expect(page.getByRole("radio", { name: "Beginner" })).toBeChecked();
  await expect(page.getByText("No account needed. Add articles, videos and PDFs once your map is ready.")).toBeVisible();
  await page.getByRole("radio", { name: "Advanced" }).check();
  await expect(page.getByRole("radio", { name: "Beginner" })).not.toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
});
