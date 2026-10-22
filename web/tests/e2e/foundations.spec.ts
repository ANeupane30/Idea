import { expect, test } from "@playwright/test";

const bodyStyle = (p: string) => getComputedStyle(document.body).getPropertyValue(p);

test("light tokens and Roboto Flex apply", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(bodyStyle, "background-color")).toBe("rgb(249, 249, 255)");
  expect(await page.evaluate(bodyStyle, "font-family")).toContain("Roboto Flex");
});

test.describe("dark", () => {
  test.use({ colorScheme: "dark" });
  test("dark tokens apply", async ({ page }) => {
    await page.goto("/");
    expect(await page.evaluate(bodyStyle, "background-color")).toBe("rgb(17, 19, 24)");
  });
});
