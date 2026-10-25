// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: (p: { href: string; children: React.ReactNode }) => <a href={p.href}>{p.children}</a> }));
vi.mock("@/lib/supabase/client", () => ({ createBrowserClient: () => ({}) }));
const sourceActions = vi.hoisted(() => ({
  addLinkSource: vi.fn(),
  addPdfSource: vi.fn(),
  addOutlineSource: vi.fn(),
  retrySource: vi.fn(),
  useSourceAnyway: vi.fn(() => new Promise(() => {})),
}));
vi.mock("@/app/goals/[id]/source-actions", () => sourceActions);
const goalActions = vi.hoisted(() => ({
  answerClarification: vi.fn(),
  retryTopicMap: vi.fn(),
  answerSourceDecision: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock("@/app/goals/actions", () => goalActions);
const lessonActions = vi.hoisted(() => ({ chooseFormat: vi.fn(), logFormatSwitch: vi.fn(), sendFeedback: vi.fn() }));
vi.mock("@/app/goals/[id]/topics/[subtopicId]/lesson-actions", () => lessonActions);

import { AddSourceContext } from "@/app/goals/[id]/add-source-context";
import { MapStatus } from "@/app/goals/[id]/MapStatus";
import { SourceList } from "@/app/goals/[id]/SourceList";
import { LessonView } from "@/app/goals/[id]/topics/[subtopicId]/LessonView";
import { stageText } from "@/lib/prep";
import type { SourceRow } from "@/lib/sources";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(cleanup);

const row = (o: Partial<SourceRow>): SourceRow => ({
  id: "s1",
  type: "web",
  url_or_file: "https://realpython.com/plants",
  file_name: null,
  title: "Plants",
  status: "processing",
  step: "extracting",
  delayed: false,
  error: null,
  relevance_label: null,
  relevance_reason: null,
  vetted: null,
  vet_reason: null,
  ...o,
});

const goal = (map_status: string) => ({
  id: "g",
  status: "active",
  map_status,
  map_delayed: false,
  clarifying_question: null,
  map_error: null,
});

describe("stageText", () => {
  it("names each stage", () => {
    expect(stageText("understanding", [], null)).toBe("Understanding your goal…");
    expect(stageText("finding_sources", [], null)).toBe("Finding learning material for your goal…");
    expect(stageText("building_map", [], null)).toBe("Designing your map…");
    expect(stageText("pending", [], null)).toBe("Designing your map…");
  });
  it("counts the sources being read (i = min(done + 1, n))", () => {
    const four = (done: number) =>
      [0, 1, 2, 3].map((i) =>
        row({ id: `s${i}`, url_or_file: `https://site${i}.example/x`, status: i < done ? "awaiting_map" : "processing" }),
      );
    expect(stageText("reading_sources", four(0), null)).toBe("Reading 1 of 4 sources: site0.example…");
    expect(stageText("reading_sources", four(1), null)).toBe("Reading 2 of 4 sources: site1.example…");
    expect(stageText("reading_sources", four(3), null)).toBe("Reading 4 of 4 sources: site3.example…");
    expect(stageText("reading_sources", four(4), null)).toBe("Reading 4 of 4 sources…");
  });
  it("leaves failed sources out of the count, and names outlines", () => {
    const rows = [row({ status: "failed" }), row({ id: "s2", type: "outline", url_or_file: "outline", status: "queued" })];
    expect(stageText("reading_sources", rows, null)).toBe("Reading 1 of 1 sources: your outline…");
  });
  it("counts what is checked and the topics ready", () => {
    expect(stageText("checking_sources", [row({ status: "awaiting_map" }), row({ id: "b", status: "awaiting_map" })], null)).toBe(
      "Checking 2 sources…",
    );
    expect(stageText("matching_sources", [], { ready: 6, total: 9 })).toBe("Preparing lessons: 6 of 9 topics ready");
  });
});

describe("MapStatus stages", () => {
  it("shows the stage and the sources while reading", () => {
    render(<MapStatus goal={goal("reading_sources")} sources={[row({}), row({ id: "s2", status: "awaiting_map" })]} />);
    expect(screen.getByRole("status").textContent).toContain("Reading 2 of 2 sources: realpython.com…");
    expect(screen.getAllByRole("list", { name: "Progress" })).toHaveLength(2);
  });
  it("shows the learner's sources reading in parallel with understanding", () => {
    render(<MapStatus goal={goal("understanding")} sources={[row({})]} />);
    expect(screen.getByRole("status").textContent).toContain("Understanding your goal…");
    expect(screen.getAllByRole("list", { name: "Progress" })).toHaveLength(1);
  });
  it("never shows the map before ready", () => {
    render(
      <MapStatus goal={goal("matching_sources")} sources={[]} topics={{ ready: 2, total: 5 }}>
        <p>THE MAP</p>
      </MapStatus>,
    );
    expect(screen.queryByText("THE MAP")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Preparing lessons: 2 of 5 topics ready");
  });
});

describe("the source decision", () => {
  const failing = [
    row({ id: "a", title: "Course sign-up", status: "awaiting_map", vetted: false, vet_reason: "A sign-up page, not course content." }),
    row({ id: "b", title: "Broken link", status: "failed", error: "We couldn't open this link." }),
    row({ id: "c", title: "Fine", status: "awaiting_map", vetted: true }),
  ];
  it("lists the failing sources with their reasons", () => {
    render(<MapStatus goal={goal("awaiting_source_decision")} sources={failing} />);
    expect(screen.getByText("Some of your sources don't look right for this goal.")).toBeTruthy();
    expect(screen.getByText("A sign-up page, not course content.")).toBeTruthy();
    expect(screen.getByText("We couldn't open this link.")).toBeTruthy();
    expect(screen.queryByText("Fine")).toBeNull();
  });
  it("finds sources or uses the learner's", async () => {
    render(<MapStatus goal={goal("awaiting_source_decision")} sources={failing} />);
    fireEvent.click(screen.getByRole("button", { name: "Find sources for me" }));
    await vi.waitFor(() => expect(goalActions.answerSourceDecision).toHaveBeenCalledWith("g", "find"));
    // Both buttons wait while an answer is sent.
    const use = screen.getByRole("button", { name: "Use mine anyway" }) as HTMLButtonElement;
    await vi.waitFor(() => expect(use.disabled).toBe(false));
    fireEvent.click(use);
    await vi.waitFor(() => expect(goalActions.answerSourceDecision).toHaveBeenCalledWith("g", "use"));
  });
});

describe("a source that didn't pass the check", () => {
  it("is marked Not used, and can be used anyway (once)", () => {
    render(
      <AddSourceContext value={vi.fn()}>
        <SourceList
          goalId="g"
          rows={[row({ status: "ready", vetted: false, vet_reason: "Off-topic for this goal." })]}
          archived={false}
          onRetry={() => {}}
        />
      </AddSourceContext>,
    );
    expect(screen.getByText("Not used: Off-topic for this goal.")).toBeTruthy();
    const use = screen.getByRole("button", { name: "Use it anyway" }) as HTMLButtonElement;
    fireEvent.click(use);
    expect(sourceActions.useSourceAnyway).toHaveBeenCalledWith("g", "s1");
    expect(use.disabled).toBe(true);
  });
});

describe("a lesson with no sources", () => {
  const props = {
    userId: "u",
    title: "4 Joins",
    summary: null,
    goalId: "g",
    goalTitle: "Learn SQL",
    subtopic: { id: "t", title: "Joins" },
    preferredFormat: "text" as const,
    formatChosen: true,
    initialLessons: {},
    hasSources: false,
  };
  it("says sources are still being read", () => {
    render(<LessonView {...props} sourcesPending />);
    expect(screen.getByText("Sources for this topic are still being read. This takes a minute or two.")).toBeTruthy();
  });
  it("says nothing good was found, without search chips", () => {
    render(<LessonView {...props} sourcesPending={false} />);
    expect(screen.getByText("We couldn't find good material for this topic yet. Add a source if you have one.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add a source" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /^Search the web for/ })).toBeNull();
  });
});
