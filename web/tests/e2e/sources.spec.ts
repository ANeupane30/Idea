import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addSourceDialog, guestBuildsMap, openAddSource } from "./helpers";

// Served by the fixture web server in playwright.config.ts.
const ARTICLE = "http://127.0.0.1:8765/sql-article.html";
const PDF = path.join(__dirname, "fixtures", "sql_basics.pdf");
const LABELS = /Highly relevant|Partly relevant|Off-topic/;

function sources(page: Page) {
  return page.getByRole("list", { name: "Your sources" }).getByRole("listitem");
}

/** Opens the dialog (if needed) and submits a link; the dialog stays open. */
async function submitLink(page: Page, url: string) {
  if (!(await addSourceDialog(page).isVisible())) await openAddSource(page);
  const dialog = addSourceDialog(page);
  await dialog.getByLabel("Paste a link to a web page or YouTube video").fill(url);
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
}

async function closeDialog(page: Page) {
  await addSourceDialog(page).getByRole("button", { name: "Done" }).click();
  await expect(addSourceDialog(page)).toBeHidden();
}

test("add a web link", async ({ page }) => {
  await guestBuildsMap(page);
  await expect(page.getByRole("heading", { name: "Sources" })).toBeVisible();
  await submitLink(page, ARTICLE);
  await expect(addSourceDialog(page).getByLabel("Paste a link to a web page or YouTube video")).toHaveValue("");
  await closeDialog(page);
  const row = sources(page).first();
  await expect(row).toContainText("Highly relevant", { timeout: 30_000 });
  await expect(row).toContainText("A practical guide to SQL");
  await expect(row).toContainText("Covers ");
});

test("upload a PDF", async ({ page }) => {
  await guestBuildsMap(page);
  await openAddSource(page);
  await addSourceDialog(page).getByLabel("Upload PDF").setInputFiles(PDF);
  await closeDialog(page);
  const row = sources(page).first();
  await expect(row).toContainText(LABELS, { timeout: 30_000 });
  await expect(row).toContainText("SQL basics");
});

test("failed link can be retried", async ({ page }) => {
  await guestBuildsMap(page);
  await submitLink(page, "http://127.0.0.1:8765/missing.html");
  await closeDialog(page);
  const row = sources(page).first();
  await expect(row).toContainText("We couldn't open this page. Check the link and try again.", { timeout: 30_000 });
  await row.getByRole("button", { name: "Try again" }).click();
  // The retry runs and fails the same way; the row stays a single source.
  await expect(row).toContainText("We couldn't open this page.", { timeout: 30_000 });
  await expect(sources(page)).toHaveCount(1);
});

test("duplicate link", async ({ page }) => {
  await guestBuildsMap(page);
  await submitLink(page, ARTICLE);
  await closeDialog(page);
  await expect(sources(page).first()).toContainText("Highly relevant", { timeout: 30_000 });
  await submitLink(page, `${ARTICLE}?utm_source=x`);
  await closeDialog(page);
  await expect(sources(page).first()).toContainText("You've already added this source to this goal.", {
    timeout: 30_000,
  });
  await expect(sources(page)).toHaveCount(2);
});

test("invalid link", async ({ page }) => {
  await guestBuildsMap(page);
  await submitLink(page, "ftp://x");
  await expect(addSourceDialog(page).getByRole("alert")).toHaveText("Enter a link that starts with http:// or https://");
  await closeDialog(page);
  await expect(sources(page)).toHaveCount(0);
});
