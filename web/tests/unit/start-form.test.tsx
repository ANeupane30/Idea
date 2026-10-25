// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StartForm } from "@/components/start-form";

afterEach(cleanup);

const action = async () => ({ ok: true }) as const;

describe("StartForm", () => {
  it("shows the three steps with the style chips, Reading checked", () => {
    render(<StartForm action={action} />);
    expect(screen.getByText("What do you want to master?")).toBeTruthy();
    expect(screen.getByText("How do you like to learn?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Where do you want to learn from?" })).toBeTruthy();
    const reading = screen.getByRole("radio", { name: "Documentation & Reading" }) as HTMLInputElement;
    expect(reading.checked).toBe(true);
    expect(screen.getByRole("radio", { name: "Visual / Video" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Hands-On / Building" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Build my learning map" })).toBeTruthy();
  });

  it("keeps the sources step collapsed until asked", () => {
    render(<StartForm action={action} />);
    const toggle = screen.getByRole("button", { name: "Where do you want to learn from?" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByRole("textbox", { name: /Link/ })).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "I don't have sources, pick the best ones for me" })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/Have a specific course, book, or playlist\?/)).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Links" }).getAttribute("aria-selected")).toBe("true");
    const links = screen.getAllByRole("textbox", { name: /Link/ }) as HTMLInputElement[];
    expect(links).toHaveLength(3);
    expect(links.every((l) => l.name === "links" && l.type === "url")).toBe(true);
    const pick = screen.getByRole("button", { name: "I don't have sources, pick the best ones for me" }) as HTMLButtonElement;
    expect(pick.type).toBe("submit");
    expect(pick.name).toBe("intent");
    expect(pick.value).toBe("pick");
  });

  it("has a Paste an outline tab with a character count", () => {
    render(<StartForm action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Where do you want to learn from?" }));
    const tab = screen.getByRole("tab", { name: "Paste an outline" });
    expect(tab.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(tab);
    expect(tab.getAttribute("aria-selected")).toBe("true");
    const outline = screen.getByRole("textbox", { name: "Your outline" }) as HTMLTextAreaElement;
    expect(outline.name).toBe("outline");
    expect(outline.maxLength).toBe(20000);
    expect(screen.getByText("0 / 20,000")).toBeTruthy();
    fireEvent.change(outline, { target: { value: "1. Tables" } });
    expect(screen.getByText("9 / 20,000")).toBeTruthy();
  });
});

