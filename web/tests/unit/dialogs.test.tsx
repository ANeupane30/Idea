// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: (p: { href: string; children: React.ReactNode }) => <a href={p.href}>{p.children}</a> }));
vi.mock("@/lib/supabase/client", () => ({ createBrowserClient: vi.fn() }));
vi.mock("@/app/goals/[id]/source-actions", () => ({ addLinkSource: vi.fn(), addPdfSource: vi.fn(), retrySource: vi.fn() }));
const lessonActions = vi.hoisted(() => ({ chooseFormat: vi.fn(), logFormatSwitch: vi.fn(), sendFeedback: vi.fn() }));
vi.mock("@/app/goals/[id]/topics/[subtopicId]/lesson-actions", () => lessonActions);

import { AddSourceDialog } from "@/app/goals/[id]/AddSourceDialog";
import { LessonView } from "@/app/goals/[id]/topics/[subtopicId]/LessonView";

beforeAll(() => {
  // jsdom has no <dialog> methods.
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(cleanup);

describe("AddSourceDialog", () => {
  it("shows a failed retry's error inside the dialog", () => {
    render(
      <AddSourceDialog goalId="g" userId="u" rows={[]} open onClose={() => {}} onRetry={() => {}} retryError="Try again tomorrow." />,
    );
    expect(screen.getByRole("alert").textContent).toBe("Try again tomorrow.");
  });
});

describe("format chooser", () => {
  it("lets the learner try again when saving the format fails", async () => {
    lessonActions.chooseFormat.mockRejectedValue(new Error("offline"));
    render(
      <LessonView
        userId="u"
        title="4 Joins"
        summary={null}
        goalId="g"
        goalTitle="Learn SQL"
        subtopic={{ id: "t", title: "Joins" }}
        preferredFormat="text"
        formatChosen={false}
        initialLessons={{}}
        hasSources
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Something went wrong. Please try again.");
    expect(screen.getByRole("button", { name: "Continue" })).toHaveProperty("disabled", false);
  });

  it("offers to add a source when no source covers the topic", () => {
    render(
      <LessonView
        userId="u"
        title="4 Joins"
        summary={null}
        goalId="g"
        goalTitle="Learn SQL"
        subtopic={{ id: "t", title: "Joins" }}
        preferredFormat="text"
        formatChosen
        initialLessons={{}}
        hasSources={false}
      />,
    );
    expect(screen.getByRole("link", { name: "Add a source" }).getAttribute("href")).toBe("/goals/g?add=source");
    expect(screen.queryByRole("link", { name: /^Search the web for/ })).toBeNull();
  });
});
