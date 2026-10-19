import { expect, type Page } from "@playwright/test";

export const TEST_PASSWORD = "correct-horse-battery";
export const START_HEADING = "What do you want to learn?";

export function newEmail(): string {
  return `e2e+${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/** The current user's id, from the site header (guests included). */
export async function userId(page: Page): Promise<string | null> {
  // Visible only: Next keeps recently visited routes mounted but hidden.
  return page.locator("header[data-user-id]:visible").getAttribute("data-user-id");
}

/**
 * Signs up a brand-new user without setting preferences. Opening /sign-up makes
 * a guest, and signing up converts it. Ends on the start page. Returns the email.
 */
export async function signUpRaw(page: Page): Promise<string> {
  const email = newEmail();
  await page.goto("/sign-up");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByRole("heading", { name: START_HEADING })).toBeVisible();
  return email;
}

/** Signs up a brand-new user, saves default preferences, and returns its email. Ends on /goals. */
export async function signUpFresh(page: Page): Promise<string> {
  const email = await signUpRaw(page);
  await page.goto("/onboarding");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/goals$/);
  return email;
}

/** As a guest on the start page, builds a map and waits until it is ready. */
export async function guestBuildsMap(page: Page, title = "Learn SQL") {
  await page.goto("/");
  await page.getByLabel("Your goal").fill(title);
  await page.getByRole("button", { name: "Build my learning map" }).click();
  await expect(page).toHaveURL(/\/goals\/[0-9a-f-]{36}/);
  await expect(page.getByRole("navigation", { name: "Topic map" })).toBeVisible({ timeout: 30_000 });
}

export const FIXTURE_ARTICLE = "http://127.0.0.1:8765/sql-article.html";

export const addSourceDialog = (page: Page) => page.getByRole("dialog", { name: "Add a source" });

/** Opens the Add source dialog with the floating button. */
export async function openAddSource(page: Page) {
  await page.getByTestId("add-source-fab").click();
  await expect(addSourceDialog(page)).toBeVisible();
}

/**
 * Adds a link through the dialog and closes it. With `wait: "ready"` (default) it waits until the
 * source is matched; with "added" only until it is listed (failures, limits and so on).
 */
export async function addLink(page: Page, url: string, { wait = "ready" }: { wait?: "ready" | "added" } = {}) {
  await openAddSource(page);
  const dialog = addSourceDialog(page);
  const field = dialog.getByLabel("Paste a link to a web page or YouTube video");
  await field.fill(url);
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  if (wait === "ready") {
    // The relevance chip shows once the source is matched ("Ready" is also the stepper's last step).
    await expect(dialog.getByRole("list", { name: "Adding to your map" })).toContainText(
      /Highly relevant|Partly relevant|Off-topic/,
      { timeout: 30_000 },
    );
  } else {
    await expect(field).toHaveValue("");
  }
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
}

/** Guest map with the fixture article added and matched. */
export async function mapWithArticle(page: Page) {
  await guestBuildsMap(page);
  await addLink(page, FIXTURE_ARTICLE);
  await expect(page.getByRole("list", { name: "Your sources" }).getByRole("listitem").first()).toContainText(
    "Highly relevant",
  );
}

export async function openLesson(page: Page, topic: string) {
  await page
    .getByRole("navigation", { name: "Topic map" })
    .getByRole("button", { name: new RegExp(`^(\\d+ )?${topic}`) })
    .click();
  await page.getByRole("dialog").getByRole("link", { name: "Open lesson" }).click();
  // The first visit compiles the route in dev, so allow longer than the default.
  await expect(page).toHaveURL(/\/goals\/[0-9a-f-]{36}\/topics\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1, name: topic })).toBeVisible();
}

/** Opens a topic's lesson by URL (gap topics have no "Open lesson" link). */
export async function openLessonByUrl(page: Page, topic: string) {
  const id = await page
    .getByRole("navigation", { name: "Topic map" })
    .getByRole("button", { name: new RegExp(`^(\\d+ )?${topic}`) })
    .getAttribute("data-topic-id");
  await page.goto(`${page.url().replace(/\/$/, "")}/topics/${id}`);
  await expect(page.getByRole("heading", { level: 1, name: topic })).toBeVisible({ timeout: 20_000 });
}

/** Topic map nodes don't overlap, and the page doesn't scroll sideways. */
export async function expectNoOverlap(page: Page, width: number) {
  const boxes = await page
    .getByRole("navigation", { name: "Topic map" })
    .locator("button[data-topic-id]")
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) {
      const overlap = a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      expect(overlap, `topics overlap at ${width}px`).toBe(false);
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}
