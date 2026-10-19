"use client";

import { useEffect, useState } from "react";

type PanelName = "sources" | "suggestions";
/** "auto": open on wide screens (xl, 1280px+), closed below. A click sets an explicit choice. */
type PanelState = "auto" | "open" | "closed";

const STORAGE_KEY = "goal-workspace-panels";
const WIDE = "(min-width: 1280px)";

function readSaved(): Record<PanelName, PanelState> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<Record<PanelName, PanelState>>;
    // Only wide-screen choices are remembered; drawers on small screens always start closed.
    if (!window.matchMedia(WIDE).matches) return null;
    return { sources: saved.sources ?? "auto", suggestions: saved.suggestions ?? "auto" };
  } catch {
    return null;
  }
}

function save(state: Record<PanelName, PanelState>) {
  try {
    if (window.matchMedia(WIDE).matches) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage blocked: the choice just isn't remembered.
  }
}

const LABEL: Record<PanelName, string> = { sources: "Sources", suggestions: "Suggestions" };

/**
 * The goal page: Sources on the left, the map in the middle and Suggestions on the right.
 * On wide screens the side panels are columns that can be collapsed; below that they are
 * drawers that start closed.
 */
export function GoalWorkspace({
  sources,
  suggestions,
  children,
}: {
  sources: React.ReactNode;
  suggestions: React.ReactNode;
  children: React.ReactNode;
}) {
  const [state, setState] = useState<Record<PanelName, PanelState>>({ sources: "auto", suggestions: "auto" });

  useEffect(() => {
    const saved = readSaved();
    // Restoring a remembered choice after hydration (the server can't know it).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved) setState(saved);
  }, []);

  function isOpen(name: PanelName): boolean {
    const s = state[name];
    if (s === "auto") return typeof window !== "undefined" && window.matchMedia(WIDE).matches;
    return s === "open";
  }

  function toggle(name: PanelName) {
    const next = { ...state, [name]: isOpen(name) ? "closed" : "open" } as Record<PanelName, PanelState>;
    setState(next);
    save(next);
  }

  function close(name: PanelName) {
    const next = { ...state, [name]: "closed" } as Record<PanelName, PanelState>;
    setState(next);
    save(next);
  }

  // Esc closes an open drawer on small screens.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || window.matchMedia(WIDE).matches) return;
      setState((s) => ({
        sources: s.sources === "open" ? "closed" : s.sources,
        suggestions: s.suggestions === "open" ? "closed" : s.suggestions,
      }));
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const drawerOpen = (["sources", "suggestions"] as const).some((n) => state[n] === "open");

  return (
    <div className="mt-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <ToggleButton name="sources" open={state} onClick={() => toggle("sources")} />
        <ToggleButton name="suggestions" open={state} onClick={() => toggle("suggestions")} />
      </div>
      <div className="xl:flex xl:items-start xl:gap-6">
        <Panel name="sources" side="left" state={state.sources} onClose={() => close("sources")}>
          {sources}
        </Panel>
        <div className="min-w-0 flex-1">{children}</div>
        <Panel name="suggestions" side="right" state={state.suggestions} onClose={() => close("suggestions")}>
          {suggestions}
        </Panel>
      </div>
      {drawerOpen && (
        <div
          aria-hidden
          onClick={() =>
            setState((s) => ({
              sources: s.sources === "open" ? "closed" : s.sources,
              suggestions: s.suggestions === "open" ? "closed" : s.suggestions,
            }))
          }
          className="fixed inset-0 z-30 bg-zinc-950/40 xl:hidden"
        />
      )}
    </div>
  );
}

function ToggleButton({
  name,
  open,
  onClick,
}: {
  name: PanelName;
  open: Record<PanelName, PanelState>;
  onClick: () => void;
}) {
  const s = open[name];
  // aria-expanded follows the visible state; "auto" is open on wide screens only (CSS decides),
  // so it is resolved after mount.
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  const expanded = s === "auto" ? wide : s === "open";
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={`${name}-panel`}
      aria-label={`${LABEL[name]} panel`}
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 aria-expanded:border-indigo-400 aria-expanded:text-indigo-700 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:aria-expanded:border-indigo-400 dark:aria-expanded:text-indigo-300"
    >
      {name === "sources" ? "◧" : "◨"} {LABEL[name]}
    </button>
  );
}

function Panel({
  name,
  side,
  state,
  onClose,
  children,
}: {
  name: PanelName;
  side: "left" | "right";
  state: PanelState;
  onClose: () => void;
  children: React.ReactNode;
}) {
  // auto: a column on wide screens, hidden below. open: a column on wide screens, a drawer below.
  const visibility = state === "auto" ? "hidden xl:block" : state === "open" ? "block" : "hidden";
  const drawer =
    side === "left"
      ? "fixed inset-y-0 left-0 border-r motion-safe:animate-[drawer-left_200ms_ease-out]"
      : "fixed inset-y-0 right-0 border-l motion-safe:animate-[drawer-right_200ms_ease-out]";
  return (
    <aside
      id={`${name}-panel`}
      aria-label={LABEL[name]}
      className={`${visibility} ${drawer} z-40 w-[min(22rem,88vw)] overflow-y-auto border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 xl:static xl:z-auto xl:w-80 xl:shrink-0 xl:animate-none xl:self-start xl:border-0 xl:bg-transparent xl:p-0 xl:shadow-none xl:dark:bg-transparent 2xl:w-96 [&>*:first-child]:mt-0`}
    >
      <div className="mb-3 flex justify-end xl:hidden">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          Close
        </button>
      </div>
      <div className="flex flex-col gap-8 [&>section]:mt-0">{children}</div>
    </aside>
  );
}
