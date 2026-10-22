// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { button } from "@/components/ui/buttons";
import { StatusChip } from "@/components/ui/chips";
import { Icon } from "@/components/ui/icon";
import { MasteryMeter } from "@/components/ui/mastery-meter";

afterEach(cleanup);

describe("Icon", () => {
  it("has no text content and is hidden", () => {
    const { container } = render(<Icon name="flag" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.textContent).toBe("");
  });
});

describe("StatusChip", () => {
  const cases = [
    ["coverage", "covered", "Covered"],
    ["coverage", "thin", "Thin"],
    ["coverage", "gap", "Gap"],
    ["relevance", "high", "Highly relevant"],
    ["relevance", "partial", "Partly relevant"],
    ["relevance", "off_topic", "Off-topic"],
    ["mastery", "strong", "Strong"],
    ["mastery", "developing", "Developing"],
    ["mastery", "weak", "Weak"],
    ["answer", "correct", "Correct"],
    ["answer", "wrong", "Not quite"],
  ] as const;
  it.each(cases)("%s %s says %s", (kind, value, word) => {
    const { container } = render(<StatusChip {...({ kind, value } as React.ComponentProps<typeof StatusChip>)} />);
    expect(screen.getByText(word)).toBeTruthy();
    expect(container.textContent).toBe(word);
    expect(container.querySelector("svg")).not.toBeNull();
  });
});

describe("MasteryMeter", () => {
  it("is an image named by its label", () => {
    render(<MasteryMeter decayed={0.4} label="developing" />);
    const img = screen.getByRole("img", { name: "Mastery: Developing" });
    expect(img.querySelector<HTMLElement>("[data-fill]")!.style.width).toBe("40%");
  });

  it("shows a sliver at zero", () => {
    render(<MasteryMeter decayed={0} label="weak" />);
    expect(screen.getByRole("img").querySelector<HTMLElement>("[data-fill]")!.style.width).toBe("4%");
  });
});

describe("button", () => {
  it("filled is a full-pill primary 48px target", () => {
    const c = button("filled");
    expect(c).toContain("bg-primary");
    expect(c).toContain("rounded-full");
    expect(c).toContain("min-h-12");
  });
});
