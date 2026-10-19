import { expect, test, type Page } from "@playwright/test";
import { signUpFresh, signUpRaw } from "./helpers";
import fixture from "../../../worker/tests/fixtures/fake_llm/topic_map.json";

// The fake worker builds every map from this fixture.
const MAP = fixture.subtopics.map((t) => ({
  title: t.title,
  summary: t.summary,
  children: t.children.map((c) => c.title),
}));
const ALL_TITLES = MAP.flatMap((t) => [t.title, ...t.children]);

async function createReadyMap(page: Page, title = "Learn SQL") {
  await page.goto("/goals");
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Create goal" }).click();
  await expect(page).toHaveURL(/\/goals\/[0-9a-f-]{36}/);
  const nav = page.getByRole("navigation", { name: "Topic map" });
  await expect(nav).toBeVisible({ timeout: 30_000 });
  return nav;
}

const mainButtons = (page: Page) =>
  page.getByRole("navigation", { name: "Topic map" }).locator("ol").first().locator(":scope > li > button");

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("shows numbered main topics in learning order", async ({ page }) => {
    await signUpFresh(page);
    await createReadyMap(page);
    await expect(mainButtons(page)).toHaveText(MAP.map((t, i) => `${i + 1} ${t.title}`));
  });

  test("renders children beside their parent", async ({ page }) => {
    await signUpFresh(page);
    const nav = await createReadyMap(page);
    for (const [i, topic] of MAP.entries()) {
      if (topic.children.length === 0) continue;
      const parentLi = nav.locator("ol").first().locator(":scope > li").nth(i);
      const parentBtn = parentLi.locator(":scope > button");
      await expect(parentBtn).toHaveText(`${i + 1} ${topic.title}`);
      const parentBox = (await parentBtn.boundingBox())!;
      for (const child of topic.children) {
        // Nested in the parent's own list item, in its child list.
        const childBtn = parentLi.locator(":scope > ol > li > button").getByText(child, { exact: true });
        await expect(childBtn).toBeVisible();
        const box = (await childBtn.boundingBox())!;
        // Desktop: the child sits in the column to the right of its parent card.
        expect(box.x).toBeGreaterThan(parentBox.x + parentBox.width);
      }
    }
  });

  test("selecting a topic shows its summary", async ({ page }) => {
    await signUpFresh(page);
    const nav = await createReadyMap(page);
    const topic2 = nav.getByRole("button", { name: `2 ${MAP[1].title}`, exact: true });
    await topic2.click();
    const panel = page.getByRole("dialog");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("heading", { name: `2 ${MAP[1].title}` })).toBeVisible();
    await expect(panel).toContainText(MAP[1].summary);

    // The opener is a disclosure for the panel, and selection looks different
    // from keyboard focus: a 2px accent border instead of the focus ring.
    const panelId = await panel.getAttribute("id");
    expect(panelId).toBeTruthy();
    await expect(topic2).toHaveAttribute("aria-expanded", "true");
    await expect(topic2).toHaveAttribute("aria-controls", panelId!);
    await expect(mainButtons(page).nth(0)).toHaveAttribute("aria-expanded", "false");
    await expect(topic2).toHaveCSS("border-top-width", "2px");
    await expect(mainButtons(page).nth(0)).toHaveCSS("border-top-width", "1px");

    const child = nav.getByRole("button", { name: MAP[1].children[0], exact: true });
    await child.click();
    await expect(panel.getByRole("heading", { name: MAP[1].children[0] })).toBeVisible();
    await expect(panel).toContainText(`Part of: ${MAP[1].title}`);
    await expect(topic2).toHaveAttribute("aria-expanded", "false");

    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(child).toBeFocused();

    // The Close button works too.
    await topic2.click();
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Close" }).click();
    await expect(panel).toBeHidden();
    await expect(topic2).toBeFocused();
  });

  test("detail card sits beside the map on wide screens", async ({ page }) => {
    await signUpFresh(page);
    const nav = await createReadyMap(page);
    await nav.getByRole("button", { name: `2 ${MAP[1].title}`, exact: true }).click();
    const panel = (await page.getByRole("dialog").boundingBox())!;
    const map = (await nav.boundingBox())!;
    expect(panel.x).toBeGreaterThanOrEqual(map.x + map.width);
    expect(panel.y).toBeLessThan(400);
  });

  test("no edit controls", async ({ page }) => {
    await signUpFresh(page);
    await createReadyMap(page);
    await mainButtons(page).nth(1).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Rename|Move up|Move down|Indent|Outdent|Add child|Add subtopic|Delete/ }),
    ).toHaveCount(0);
  });

  test("level badge", async ({ page }) => {
    await signUpRaw(page);
    await page.goto("/onboarding");
    await page.getByRole("radio", { name: /Advanced/ }).check();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page).toHaveURL(/\/goals$/);
    await createReadyMap(page);
    const goalUrl = page.url();
    await expect(page.getByText("Built for: Advanced", { exact: true })).toBeVisible();

    // The badge names the level the map was built for, so changing the learner's
    // level afterwards must not change it.
    await page.goto("/onboarding");
    await page.getByRole("radio", { name: /Beginner/ }).check();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page).toHaveURL(/\/goals$/);
    await page.goto(goalUrl);
    await expect(mainButtons(page)).toHaveCount(MAP.length);
    await expect(page.getByText("Built for: Advanced", { exact: true })).toBeVisible();
    await expect(page.getByText(/Built for: Beginner/)).toHaveCount(0);
  });

  test("archived goal shows map", async ({ page }) => {
    await signUpFresh(page);
    await createReadyMap(page, "Learn SQL");
    const url = page.url();
    await page.goto("/goals");
    await page
      .getByRole("region", { name: "Active" })
      .getByRole("listitem")
      .filter({ hasText: "Learn SQL" })
      .getByRole("button", { name: "Archive" })
      .click();
    await expect(page.getByRole("region", { name: "Archived" }).getByText("Learn SQL")).toBeVisible();
    await page.goto(url);
    const nav = page.getByRole("navigation", { name: "Topic map" });
    await expect(mainButtons(page)).toHaveCount(6);
    for (const t of ALL_TITLES) await expect(nav.getByText(t, { exact: true })).toBeVisible();
  });
});

test.describe("tablet", () => {
  // From md up the map uses the desktop column layout, but below xl the detail
  // panel is a bottom sheet so it never squeezes the map.
  test.use({ viewport: { width: 1024, height: 768 } });

  test("panel does not clip the map at 1024", async ({ page }) => {
    await signUpFresh(page);
    const nav = await createReadyMap(page);
    await nav.getByRole("button", { name: `2 ${MAP[1].title}`, exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const navBox = (await nav.boundingBox())!;
    const buttons = await mainButtons(page).all();
    expect(buttons).toHaveLength(MAP.length);
    for (const button of buttons) {
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(navBox.x);
      expect(box.y).toBeGreaterThanOrEqual(navBox.y);
      expect(box.x + box.width).toBeLessThanOrEqual(navBox.x + navBox.width);
      expect(box.y + box.height).toBeLessThanOrEqual(navBox.y + navBox.height);
    }
    const { scrollWidth, clientWidth } = await nav.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("mobile layout has no horizontal scroll", async ({ page }) => {
    await signUpFresh(page);
    const nav = await createReadyMap(page);
    for (const t of ALL_TITLES) {
      await expect(nav.getByText(t, { exact: true })).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });
});
