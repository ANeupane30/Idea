import { expect, test, type Page } from "@playwright/test";
import { signUpFresh } from "./helpers";

const LIMIT = "Free plan allows 2 active goals. Archive one to add another.";

async function addGoal(page: Page, title: string) {
  await page.goto("/goals");
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Create goal" }).click();
}

test("creating a goal lands on its page", async ({ page }) => {
  await signUpFresh(page);
  await addGoal(page, "Learn SQL");
  await expect(page).toHaveURL(/\/goals\/[0-9a-f-]{36}/);
  await expect(page.getByRole("heading", { level: 1, name: "Learn SQL" })).toBeVisible();
});

test("limit, archive, unarchive", async ({ page }) => {
  await signUpFresh(page);
  await addGoal(page, "One");
  await expect(page).toHaveURL(/\/goals\/[0-9a-f-]{36}/);
  await addGoal(page, "Two");
  await expect(page).toHaveURL(/\/goals\/[0-9a-f-]{36}/);
  await addGoal(page, "Three");
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(LIMIT);

  const active = page.getByRole("region", { name: "Active" });
  await active.getByRole("listitem").filter({ hasText: "One" }).getByRole("button", { name: "Archive" }).click();
  const archived = page.getByRole("region", { name: "Archived" });
  await expect(archived.getByText("One")).toBeVisible();

  await page.getByLabel("Title").fill("Three");
  await page.getByRole("button", { name: "Create goal" }).click();
  await expect(page).toHaveURL(/\/goals\/[0-9a-f-]{36}/);

  await page.goto("/goals");
  await page.getByRole("region", { name: "Archived" }).getByRole("button", { name: "Unarchive" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(LIMIT);
});
