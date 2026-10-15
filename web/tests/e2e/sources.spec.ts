import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { guestBuildsMap } from "./helpers";

// Served by the fixture web server in playwright.config.ts.
const ARTICLE = "http://127.0.0.1:8765/sql-article.html";
const PDF = path.join(__dirname, "fixtures", "sql_basics.pdf");
const LABELS = /Highly relevant|Partly relevant|Off-topic/;

function sources(page: Page) {
  return page.getByRole("list", { name: "Your sources" }).getByRole("listitem");
}

async function addLink(page: Page, url: string) {
  await page.getByLabel("Add a link").fill(url);
  await page.getByRole("button", { name: "Add link" }).click();
}

test("add a web link", async ({ page }) => {
  await guestBuildsMap(page);
  await expect(page.getByRole("heading", { name: "Sources" })).toBeVisible();
  await addLink(page, ARTICLE);
  const row = sources(page).first();
  await expect(row).toContainText("Web page");
  await expect(row).toContainText("Highly relevant", { timeout: 30_000 });
  await expect(row).toContainText("A practical guide to SQL");
  await expect(row).toContainText("Covers ");
  await expect(page.getByLabel("Add a link")).toHaveValue("");
});

test("upload a PDF", async ({ page }) => {
  await guestBuildsMap(page);
  await page.getByLabel("Upload a PDF").setInputFiles(PDF);
  const row = sources(page).first();
  await expect(row).toContainText("PDF");
  await expect(row).toContainText(LABELS, { timeout: 30_000 });
  await expect(row).toContainText("SQL basics");
});

test("failed link can be retried", async ({ page }) => {
  await guestBuildsMap(page);
  await addLink(page, "http://127.0.0.1:8765/missing.html");
  const row = sources(page).first();
  await expect(row).toContainText("We couldn't open this page. Check the link and try again.", { timeout: 30_000 });
  await row.getByRole("button", { name: "Try again" }).click();
  // The retry runs and fails the same way; the row stays a single source.
  await expect(row).toContainText("We couldn't open this page.", { timeout: 30_000 });
  await expect(sources(page)).toHaveCount(1);
});

test("duplicate link", async ({ page }) => {
  await guestBuildsMap(page);
  await addLink(page, ARTICLE);
  await expect(sources(page).first()).toContainText("Highly relevant", { timeout: 30_000 });
  await addLink(page, `${ARTICLE}?utm_source=x`);
  await expect(sources(page).first()).toContainText("You've already added this source to this goal.", {
    timeout: 30_000,
  });
  await expect(sources(page)).toHaveCount(2);
});

test("guest source limit", async ({ page }) => {
  await guestBuildsMap(page);
  for (const n of [1, 2, 3]) {
    await addLink(page, `${ARTICLE}?n=${n}`);
    await expect(sources(page)).toHaveCount(n);
  }
  await addLink(page, `${ARTICLE}?n=4`);
  const alert = page.getByRole("region", { name: "Sources" }).getByRole("alert");
  await expect(alert).toHaveText("Sign up free to add more sources.");
  await expect(alert.getByRole("link", { name: "Sign up free" })).toHaveAttribute("href", "/sign-up");
  await expect(sources(page)).toHaveCount(3);
});

test("invalid link", async ({ page }) => {
  await guestBuildsMap(page);
  await addLink(page, "ftp://x");
  await expect(page.getByRole("region", { name: "Sources" }).getByRole("alert")).toHaveText(
    "Enter a link that starts with http:// or https://",
  );
  await expect(sources(page)).toHaveCount(0);
});
