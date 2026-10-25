// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createBrowserClient: vi.fn() }));
vi.mock("@/app/goals/[id]/source-actions", () => ({ addLinkSource: vi.fn(), addPdfSource: vi.fn(), retrySource: vi.fn() }));

import { Workspace } from "@/app/goals/[id]/Workspace";

afterEach(cleanup);

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});

function renderWorkspace(openAddSource = false) {
  render(
    <Workspace
      goalId="g"
      userId="u"
      archived={false}
      isGuest={false}
      sources={[]}
      openAddSource={openAddSource}
      map={<div />}
    />,
  );
}

describe("Workspace ?add=source", () => {
  it("opens the Add source dialog when asked", () => {
    renderWorkspace(true);
    expect(screen.getByRole("dialog", { name: "Add a source" })).toBeTruthy();
  });
  it("keeps it closed otherwise", () => {
    renderWorkspace();
    expect(screen.queryByRole("dialog", { name: "Add a source" })).toBeNull();
  });
});
