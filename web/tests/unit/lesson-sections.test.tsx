// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LessonSections } from "@/components/lesson-sections";

describe("LessonSections", () => {
  it("renders untrusted markdown inertly", () => {
    const { container, getByRole } = render(
      <LessonSections
        sections={[
          {
            markdown: "## Joins\n\nText <img src=x onerror=alert(1)> and [click](javascript:alert(1)).",
            mermaid: null,
            citations: [1],
          },
        ]}
        sources={[{ n: 1, title: "SQL guide", type: "web", href: "https://e.com/a#:~:text=Joins", label: "" }]}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    for (const a of Array.from(container.querySelectorAll("a"))) {
      expect(a.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
    }
    expect(getByRole("heading", { name: "Joins" })).toBeTruthy();
    const cite = getByRole("link", { name: "[1]" });
    expect(cite.getAttribute("href")).toBe("https://e.com/a#:~:text=Joins");
    expect(cite.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("labels PDF citations without a link", () => {
    const { container } = render(
      <LessonSections
        sections={[{ markdown: "Text", mermaid: null, citations: [1] }]}
        sources={[{ n: 1, title: "notes.pdf", type: "pdf", href: null, label: "page 3" }]}
      />,
    );
    expect(container.textContent).toContain("[1] notes.pdf, page 3");
    expect(container.querySelector("a")).toBeNull();
  });
});
