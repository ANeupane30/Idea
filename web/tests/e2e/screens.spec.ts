import { expect, test, type Page } from "@playwright/test";
import { mapWithArticle } from "./helpers";

// Design review screenshots, not a test: SCREENS=<dir> npx playwright test screens.spec.ts
const DIR = process.env.SCREENS;
test.skip(!DIR, "set SCREENS to a directory to take screenshots");

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: true });
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    test(`screens ${scheme}`, async ({ page }) => {
      test.slow();
      await page.goto("/");
    await expect(page.getByRole("button", { name: "Build my learning map" })).toBeVisible();
      await shot(page, `${scheme}-start`);
      await mapWithArticle(page);
      await page.getByRole("navigation", { name: "Topic map" }).getByRole("button", { name: /^\d+ Joining tables/ }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await shot(page, `${scheme}-map`);
      await page.keyboard.press("Escape");
      await page.getByTestId("add-source-fab").click();
      await page.getByRole("dialog", { name: "Add a source" }).getByLabel(/Paste a link/).fill("http://127.0.0.1:8765/missing.html");
      await page.getByRole("dialog", { name: "Add a source" }).getByRole("button", { name: "Add", exact: true }).click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${DIR}/${scheme}-dialog.png` });
      await page.keyboard.press("Escape");
      await page.getByRole("navigation", { name: "Topic map" }).getByRole("button", { name: /^\d+ Joining tables/ }).click();
      await page.getByRole("dialog").getByRole("link", { name: "Open lesson" }).click();
      await expect(page.getByRole("dialog", { name: "How do you like to learn?" })).toBeVisible({ timeout: 20_000 });
      await page.screenshot({ path: `${DIR}/${scheme}-chooser.png` });
      await page.getByRole("radio", { name: /^Visual/ }).check();
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByRole("link", { name: "Quiz me on this" })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("figure", { name: "Diagram" }).first().locator("svg")).toBeVisible();
      await shot(page, `${scheme}-lesson`);
      await page.getByRole("link", { name: "Quiz me on this" }).click();
      await expect(page.getByText("Question 1 of 5")).toBeVisible({ timeout: 30_000 });
      for (let n = 1; n <= 5; n++) {
        await expect(page.getByText(`Question ${n} of 5`)).toBeVisible();
        await page.getByRole("radio", { name: n === 1 ? "Joins delete rows." : "Joins combine rows from related tables.", exact: true }).check();
        await page.getByRole("button", { name: "Check answer" }).click();
        await expect(page.getByRole("button", { name: n < 5 ? "Next" : "See results" })).toBeVisible();
        if (n === 1) await shot(page, `${scheme}-quiz`);
        await page.getByRole("button", { name: n < 5 ? "Next" : "See results" }).click();
      }
      await expect(page.getByRole("heading", { name: /^\d of 5$/ })).toBeVisible();
      await page.waitForTimeout(1500);
      await shot(page, `${scheme}-results`);
    });
  });
}

test.describe("phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test("screens phone", async ({ page }) => {
    test.slow();
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Build my learning map" })).toBeVisible();
    await shot(page, "phone-start");
    await mapWithArticle(page);
    await shot(page, "phone-map");
  });
});
