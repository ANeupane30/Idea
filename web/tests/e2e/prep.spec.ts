import { expect, test, type Page } from "@playwright/test";
import { openLesson } from "./helpers";

// Each test finds, reads and checks sources, then builds a map: allow 90 s.
test.beforeEach(() => test.slow());

const SIGN_IN_WALL = "http://127.0.0.1:8765/sign-in-wall.html";
const OFFTOPIC_NOTE = "http://127.0.0.1:8765/offtopic-note.html";
const PAYWALLED = "We can't read this page, it needs a login. Paste the course's syllabus or table of contents instead.";
const DECISION = "Some of your sources don't look right for this goal.";
const STAGES = [/^Understanding your goal/, /^Finding learning material/, /^Reading \d of \d sources/, /^Checking \d sources/, /^Designing your map/, /^Preparing lessons/];

/** A goal whose found pages are new to the worker, so they're really read (slowly; see fixtures/server.py). */
const freshGoal = () => `Discoverme${Date.now().toString(36)} SQL joins`;

const map = (page: Page) => page.getByRole("navigation", { name: "Topic map" });
const sources = (page: Page) => page.getByRole("list", { name: "Your sources" });
const stage = (page: Page) => page.getByRole("status").first();

async function start(page: Page, title: string, { links = [], pick = false }: { links?: string[]; pick?: boolean } = {}) {
  await page.goto("/");
  await page.getByLabel("Your goal").fill(title);
  if (links.length || pick) await page.getByRole("button", { name: "Where do you want to learn from?" }).click();
  for (const [i, link] of links.entries()) await page.getByRole("textbox", { name: `Link ${i + 1}` }).fill(link);
  if (pick) await page.getByRole("button", { name: "I don't have sources, pick the best ones for me" }).click();
  else await page.getByRole("button", { name: "Build my learning map" }).click();
  await expect(page).toHaveURL(/\/goals\/[0-9a-f-]{36}/);
}

/** The stage lines seen until the map shows (polled; a quick stage may be missed, never reordered). */
async function stagesUntilMap(page: Page): Promise<string[]> {
  const seen: string[] = [];
  const deadline = Date.now() + 80_000;
  while (Date.now() < deadline) {
    if (await map(page).isVisible()) return seen;
    const text = (await stage(page).textContent({ timeout: 1_000 }).catch(() => null))?.trim();
    if (text && seen.at(-1) !== text) seen.push(text);
    await page.waitForTimeout(250);
  }
  throw new Error(`no map; stages seen: ${seen.join(" | ")}`);
}

test("pick for me finds, checks and prepares before the map appears", async ({ page }) => {
  await start(page, freshGoal(), { pick: true });
  const seen = await stagesUntilMap(page);

  const order = seen.map((t) => STAGES.findIndex((re) => re.test(t))).filter((i) => i >= 0);
  expect(order, seen.join(" | ")).toEqual([...order].sort((a, b) => a - b));
  expect(seen.some((t) => /^Reading \d of 3 sources: 127\.0\.0\.\d…$/.test(t)), seen.join(" | ")).toBe(true);

  await expect(sources(page)).toContainText("Discoverme guide one: SQL joins");
  await expect(sources(page)).toContainText("Discoverme guide two: SQL queries");
  await expect(sources(page)).not.toContainText("An offtopic page about gardening");
  await expect(page.getByText("Try searching for")).toHaveCount(0);

  await openLesson(page, "Joining tables");
  await page.getByRole("button", { name: "Continue" }).click();
  const lesson = page.getByLabel("Lesson", { exact: true });
  await expect(lesson.locator("section").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("We couldn't find good material for this topic yet.")).toHaveCount(0);
});

test("a sign-in-wall link asks before searching", async ({ page }) => {
  await start(page, "Discoverme SQL joins", { links: [SIGN_IN_WALL] });
  await expect(page.getByRole("heading", { name: DECISION })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(PAYWALLED)).toBeVisible();

  await page.getByRole("button", { name: "Find sources for me" }).click();
  await expect(map(page)).toBeVisible({ timeout: 80_000 });
  await expect(sources(page)).toContainText("Discoverme guide one: SQL joins");
  // The link the learner gave stays in the list with why it isn't used.
  await expect(sources(page).getByRole("listitem").filter({ hasText: PAYWALLED })).toBeVisible();
});

test("an off-topic link, then find sources for me, gives a map (the question is asked once)", async ({ page }) => {
  await start(page, freshGoal(), { links: [OFFTOPIC_NOTE] });
  await expect(page.getByRole("heading", { name: DECISION })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Find sources for me" }).click();
  await expect(map(page)).toBeVisible({ timeout: 80_000 });
  await expect(sources(page)).toContainText("Discoverme guide one: SQL joins");
  await expect(sources(page).getByRole("listitem").filter({ hasText: "An offtopic note on tomato gardening" })).toContainText(
    "Not used:",
  );
});

test("use mine anyway builds from the learner's source", async ({ page }) => {
  await start(page, "Learn SQL", { links: [OFFTOPIC_NOTE] });
  await expect(page.getByRole("heading", { name: DECISION })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("An offtopic note on tomato gardening")).toBeVisible();

  await page.getByRole("button", { name: "Use mine anyway" }).click();
  await expect(map(page)).toBeVisible({ timeout: 60_000 });
  await expect(sources(page)).toContainText("An offtopic note on tomato gardening");
  await expect(sources(page)).not.toContainText("Not used");
});

test("reloading mid-preparation keeps the stage", async ({ page }) => {
  await start(page, freshGoal(), { pick: true });
  await expect(stage(page)).toContainText(/^Reading \d of 3 sources/, { timeout: 30_000 });
  await page.reload();
  await expect(stage(page)).toContainText(/^(Reading \d of 3 sources|Checking \d sources|Designing your map|Preparing lessons)/);
  await expect(map(page)).toHaveCount(0);
  await expect(map(page)).toBeVisible({ timeout: 80_000 });
});
