import { expect, test } from "@playwright/test";
import { addSourceDialog, FIXTURE_ARTICLE, guestBuildsMap, mapWithArticle, openAddSource } from "./helpers";

test("add a link from the dialog", async ({ page }) => {
  await guestBuildsMap(page);
  await openAddSource(page);
  const dialog = addSourceDialog(page);
  await dialog.getByLabel("Paste a link to a web page or YouTube video").fill(FIXTURE_ARTICLE);
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  const row = dialog.getByRole("list", { name: "Adding to your map" }).getByRole("listitem").first();
  await expect(row).toContainText("Highly relevant", { timeout: 30_000 });
  await expect(row.getByRole("list", { name: "Progress" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("list", { name: "Your sources" }).getByRole("listitem").first()).toContainText(
    "Highly relevant",
  );
});

test("focus returns to the opener", async ({ page }) => {
  await guestBuildsMap(page);
  const fab = page.getByTestId("add-source-fab");
  await fab.click();
  await expect(addSourceDialog(page)).toBeVisible();
  await expect(addSourceDialog(page).getByLabel("Paste a link to a web page or YouTube video")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(addSourceDialog(page)).toBeHidden();
  await expect(fab).toBeFocused();
});

test("limit error shows in the dialog", async ({ page }) => {
  await guestBuildsMap(page);
  await openAddSource(page);
  const dialog = addSourceDialog(page);
  const field = dialog.getByLabel("Paste a link to a web page or YouTube video");
  const rows = dialog.getByRole("list", { name: "Adding to your map" }).getByRole("listitem");
  for (const n of [1, 2, 3]) {
    await field.fill(`${FIXTURE_ARTICLE}?n=${n}`);
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(rows).toHaveCount(n);
    await expect(field).toHaveValue("");
  }
  await field.fill(`${FIXTURE_ARTICLE}?n=4`);
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  const alert = dialog.getByRole("alert");
  await expect(alert).toHaveText("Sign up free to add more sources.");
  await expect(alert.getByRole("link", { name: "Sign up free" })).toHaveAttribute("href", "/sign-up");
  await expect(rows).toHaveCount(3);
});

test("gap topic opens the dialog", async ({ page }) => {
  await mapWithArticle(page);
  await page
    .getByRole("navigation", { name: "Topic map" })
    .getByRole("button", { name: /^\d+ Indexes and query performance/ })
    .click();
  const panel = page.getByRole("dialog", { name: /Indexes and query performance/ });
  await expect(panel.getByRole("link", { name: "Open lesson" })).toHaveCount(0);
  await panel.getByRole("button", { name: "Add source" }).click();
  await expect(addSourceDialog(page)).toBeVisible();
});
