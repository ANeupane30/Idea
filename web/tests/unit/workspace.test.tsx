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

function renderWorkspace(discovering: boolean, openAddSource = false) {
  render(
    <Workspace
      goalId="g"
      userId="u"
      archived={false}
      isGuest={false}
      sources={[]}
      discovering={discovering}
      openAddSource={openAddSource}
      map={<div />}
      suggestions={null}
    />,
  );
}

describe("Workspace discovery note", () => {
  it("says sources are being found while discovery runs", () => {
    renderWorkspace(true);
    expect(screen.getByRole("status").textContent).toBe("Finding sources for your topics…");
  });
  it("is gone once discovery is done", () => {
    renderWorkspace(false);
    expect(screen.queryByText("Finding sources for your topics…")).toBeNull();
  });
});

describe("Workspace ?add=source", () => {
  it("opens the Add source dialog when asked", () => {
    renderWorkspace(false, true);
    expect(screen.getByRole("dialog", { name: "Add a source" })).toBeTruthy();
  });
  it("keeps it closed otherwise", () => {
    renderWorkspace(false);
    expect(screen.queryByRole("dialog", { name: "Add a source" })).toBeNull();
  });
});
