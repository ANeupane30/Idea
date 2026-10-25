// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: (p: { href: string; children: React.ReactNode }) => <a href={p.href}>{p.children}</a> }));
vi.mock("@/lib/supabase/client", () => ({ createBrowserClient: () => ({}) }));
vi.mock("@/app/goals/[id]/source-actions", () => ({
  addLinkSource: vi.fn(),
  addPdfSource: vi.fn(),
  addOutlineSource: vi.fn(),
  retrySource: vi.fn(),
}));
const goalActions = vi.hoisted(() => ({
  answerClarification: vi.fn(),
  retryTopicMap: vi.fn(),
  answerSourceDecision: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock("@/app/goals/actions", () => goalActions);

import { AddSourceDialog } from "@/app/goals/[id]/AddSourceDialog";
import { AddSourceContext } from "@/app/goals/[id]/add-source-context";
import { MapStatus } from "@/app/goals/[id]/MapStatus";
import { SourceList } from "@/app/goals/[id]/SourceList";
import { TopicMap } from "@/app/goals/[id]/TopicMap";
import { PAYWALLED, type SourceRow } from "@/lib/sources";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  // jsdom has no matchMedia (the map uses it for the wide-screen layout).
  window.matchMedia = ((query: string) =>
    ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
});
afterEach(cleanup);

const row = (o: Partial<SourceRow>): SourceRow => ({
  id: "s1",
  type: "web",
  url_or_file: "https://a.example/x",
  file_name: null,
  title: "A page",
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

describe("MapStatus while reading the learner's sources", () => {
  it("shows each source's progress", () => {
    render(
      <MapStatus
        goal={goal("reading_sources")}
        sources={[
          row({}),
          row({ id: "s2", type: "outline", url_or_file: "outline", title: null, status: "awaiting_map", step: null }),
        ]}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Reading 2 of 2 sources: a.example…");
    expect(screen.getAllByRole("list", { name: "Progress" })).toHaveLength(2);
    expect(screen.getByText("Your outline")).toBeTruthy();
  });

  it("shows building_map like a map being built", () => {
    render(<MapStatus goal={goal("building_map")} />);
    expect(screen.getByRole("status").textContent).toContain("Designing your map…");
  });
});

describe("Add source dialog outline tab", () => {
  it("opens on the outline tab when asked", () => {
    render(
      <AddSourceDialog goalId="g" userId="u" rows={[]} open initialTab="outline" onClose={() => {}} onRetry={() => {}} />,
    );
    expect(screen.getByRole("tab", { name: "Paste an outline" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("textbox", { name: "Your outline" })).toBeTruthy();
  });
  it("opens on the link tab by default", () => {
    render(<AddSourceDialog goalId="g" userId="u" rows={[]} open onClose={() => {}} onRetry={() => {}} />);
    expect(screen.getByRole("tab", { name: "Link or PDF" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByLabelText("Paste a link to a web page or YouTube video")).toBeTruthy();
  });
});

describe("a paywalled source", () => {
  it("offers to paste an outline instead", () => {
    const open = vi.fn();
    render(
      <AddSourceContext value={open}>
        <SourceList
          goalId="g"
          rows={[row({ status: "failed", step: "extracting", error: PAYWALLED })]}
          archived={false}
          onRetry={() => {}}
        />
      </AddSourceContext>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Paste an outline" }));
    expect(open).toHaveBeenCalledWith({ tab: "outline" });
  });
});

describe("TopicMap main reference", () => {
  it("shows the topic's main reference in its detail card", () => {
    render(
      <TopicMap
        goalId="g"
        goalTitle="Learn SQL"
        tree={[{ id: "t1", title: "Joins", summary: "Combining rows.", position: 0, parent_id: null, children: [] } as never]}
        mainReferences={{ t1: { title: "SQL guide", label: "page 4", href: null } }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Joins/ }));
    expect(screen.getByText("Main reference: SQL guide, page 4")).toBeTruthy();
  });
});
