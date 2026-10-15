"use client";

import { useEffect, useId, useRef, useState } from "react";
import { LABEL_TEXT, searchQuery, type NodeCoverage } from "@/lib/sources";
import type { TreeNode } from "@/lib/topic-tree";
import { CoverageBadge, SearchLinks } from "./Coverage";

export type Level = "beginner" | "intermediate" | "advanced";

const LEVEL_LABEL: Record<Level, string> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
};

// One accent per branch, cycling. Full class strings so Tailwind can see them.
type Accent = {
  badge: string;
  edge: string;
  line: string;
  /** Child chip text and hover; pair with chipIdle or chipSelected for border and fill. */
  chip: string;
  chipIdle: string;
  chipSelected: string;
  /** Border and fill of a selected main-topic card. */
  cardSelected: string;
  ring: string;
  text: string;
};
const ACCENTS: Accent[] = [
  {
    badge: "bg-indigo-100 text-indigo-700 dark:bg-indigo-400/15 dark:text-indigo-300",
    edge: "border-l-indigo-500 dark:border-l-indigo-400",
    line: "bg-indigo-300 dark:bg-indigo-400/50",
    chip: "text-indigo-950 hover:bg-indigo-100 dark:text-indigo-100 dark:hover:bg-indigo-400/20",
    chipIdle: "border-indigo-200 bg-indigo-50 dark:border-indigo-400/25 dark:bg-indigo-400/10",
    chipSelected: "border-indigo-500 bg-indigo-100 dark:border-indigo-400 dark:bg-indigo-400/25",
    cardSelected: "border-indigo-500 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-400/10",
    ring: "ring-indigo-500 dark:ring-indigo-400",
    text: "text-indigo-700 dark:text-indigo-300",
  },
  {
    badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
    edge: "border-l-emerald-500 dark:border-l-emerald-400",
    line: "bg-emerald-300 dark:bg-emerald-400/50",
    chip: "text-emerald-950 hover:bg-emerald-100 dark:text-emerald-100 dark:hover:bg-emerald-400/20",
    chipIdle: "border-emerald-200 bg-emerald-50 dark:border-emerald-400/25 dark:bg-emerald-400/10",
    chipSelected: "border-emerald-500 bg-emerald-100 dark:border-emerald-400 dark:bg-emerald-400/25",
    cardSelected: "border-emerald-500 bg-emerald-50 dark:border-emerald-400 dark:bg-emerald-400/10",
    ring: "ring-emerald-500 dark:ring-emerald-400",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  {
    badge: "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
    edge: "border-l-amber-500 dark:border-l-amber-400",
    line: "bg-amber-300 dark:bg-amber-400/50",
    chip: "text-amber-950 hover:bg-amber-100 dark:text-amber-100 dark:hover:bg-amber-400/20",
    chipIdle: "border-amber-200 bg-amber-50 dark:border-amber-400/25 dark:bg-amber-400/10",
    chipSelected: "border-amber-500 bg-amber-100 dark:border-amber-400 dark:bg-amber-400/25",
    cardSelected: "border-amber-500 bg-amber-50 dark:border-amber-400 dark:bg-amber-400/10",
    ring: "ring-amber-500 dark:ring-amber-400",
    text: "text-amber-800 dark:text-amber-300",
  },
  {
    badge: "bg-rose-100 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300",
    edge: "border-l-rose-500 dark:border-l-rose-400",
    line: "bg-rose-300 dark:bg-rose-400/50",
    chip: "text-rose-950 hover:bg-rose-100 dark:text-rose-100 dark:hover:bg-rose-400/20",
    chipIdle: "border-rose-200 bg-rose-50 dark:border-rose-400/25 dark:bg-rose-400/10",
    chipSelected: "border-rose-500 bg-rose-100 dark:border-rose-400 dark:bg-rose-400/25",
    cardSelected: "border-rose-500 bg-rose-50 dark:border-rose-400 dark:bg-rose-400/10",
    ring: "ring-rose-500 dark:ring-rose-400",
    text: "text-rose-700 dark:text-rose-300",
  },
  {
    badge: "bg-sky-100 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300",
    edge: "border-l-sky-500 dark:border-l-sky-400",
    line: "bg-sky-300 dark:bg-sky-400/50",
    chip: "text-sky-950 hover:bg-sky-100 dark:text-sky-100 dark:hover:bg-sky-400/20",
    chipIdle: "border-sky-200 bg-sky-50 dark:border-sky-400/25 dark:bg-sky-400/10",
    chipSelected: "border-sky-500 bg-sky-100 dark:border-sky-400 dark:bg-sky-400/25",
    cardSelected: "border-sky-500 bg-sky-50 dark:border-sky-400 dark:bg-sky-400/10",
    ring: "ring-sky-500 dark:ring-sky-400",
    text: "text-sky-700 dark:text-sky-300",
  },
  {
    badge: "bg-violet-100 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300",
    edge: "border-l-violet-500 dark:border-l-violet-400",
    line: "bg-violet-300 dark:bg-violet-400/50",
    chip: "text-violet-950 hover:bg-violet-100 dark:text-violet-100 dark:hover:bg-violet-400/20",
    chipIdle: "border-violet-200 bg-violet-50 dark:border-violet-400/25 dark:bg-violet-400/10",
    chipSelected: "border-violet-500 bg-violet-100 dark:border-violet-400 dark:bg-violet-400/25",
    cardSelected: "border-violet-500 bg-violet-50 dark:border-violet-400 dark:bg-violet-400/10",
    ring: "ring-violet-500 dark:ring-violet-400",
    text: "text-violet-700 dark:text-violet-300",
  },
];
const accentFor = (index: number) => ACCENTS[index % ACCENTS.length];

const TRUNK = "bg-zinc-300 dark:bg-zinc-600";

/*
 * Connector geometry. Every connector is an absolutely positioned 2px span.
 * Mobile: a vertical tree. Main topics hang off a trunk 20px left of the list
 * (the list has 40px left padding), level with each card's number badge (26px
 * down). Children hang off a trunk under their parent's badge.
 * Desktop (md+): columns. --tm-half is half the gap between columns; each
 * trunk sits in the middle of its gap and each stub spans half of it.
 */

/** Vertical trunk segment for item `i` of `count`, so segments join into one line. */
function segment(i: number, count: number, kind: "main" | "child") {
  const first = i === 0;
  const last = i === count - 1;
  const mobile =
    kind === "main"
      ? `left-[-20px] ${first ? "top-[-12px]" : "top-0"} ${last ? (first ? "h-[39px]" : "h-[27px]") : "bottom-0"}`
      : `left-[-20px] ${first ? "top-[-8px]" : "top-0"} ${last ? (first ? "h-[25px]" : "h-[17px]") : "bottom-0"}`;
  const desktop =
    count === 1
      ? "md:hidden"
      : `md:left-[calc(var(--tm-half)*-1)] ${first ? "md:top-1/2" : "md:top-0"} ${last ? "md:bottom-1/2 md:h-auto" : "md:bottom-0"}`;
  return `${mobile} ${desktop}`;
}

/** Horizontal stub from the trunk to item's left edge. */
function stub(kind: "main" | "child") {
  return `left-[-20px] w-5 ${kind === "main" ? "top-[25px]" : "top-[16px]"} md:left-[calc(var(--tm-half)*-1)] md:w-(--tm-half) md:top-[calc(50%-1px)]`;
}

type Selection = { node: TreeNode; index: number; parent: TreeNode | null; branch: number };

export function TopicMap({
  goalTitle,
  level,
  tree,
  coverage,
}: {
  goalTitle: string;
  level: Level | null;
  tree: TreeNode[];
  /** Per-subtopic coverage; badges show only when given (the goal has a ready source). */
  coverage?: Record<string, NodeCoverage>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  const selection = findSelection(tree, selectedId);

  function open(id: string, opener: HTMLButtonElement) {
    openerRef.current = opener;
    setSelectedId(id);
  }

  function close() {
    setSelectedId(null);
    openerRef.current?.focus();
  }

  // Move focus into the panel whenever its topic changes, and when the panel is
  // the side card (xl+) keep the selected node in view (the map scrolls inside
  // its own box if the panel ever leaves too little room). Below xl the panel
  // is a bottom sheet, so it never narrows the map.
  useEffect(() => {
    if (!selectedId) return;
    panelRef.current?.focus({ preventScroll: true });
    if (window.matchMedia("(min-width: 1280px)").matches) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      document
        .querySelector(`[data-topic-id="${selectedId}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduce ? "auto" : "smooth" });
    }
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setSelectedId(null);
        openerRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedId]);

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {level && (
          <span className="inline-flex items-center rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 text-xs font-semibold tracking-wide text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
            Built for: {LEVEL_LABEL[level]}
          </span>
        )}
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Your learning path, designed for your level. Start at 1 and work down.
        </p>
      </div>

      <div className="mt-6 xl:flex xl:items-start xl:gap-6">
        <nav
          aria-label="Topic map"
          className="[--tm-half:1.25rem] md:flex md:w-fit md:min-w-0 md:max-w-full md:items-center md:scroll-p-6 md:overflow-x-auto md:rounded-3xl md:border md:border-zinc-200 md:bg-zinc-50/70 md:bg-[radial-gradient(circle,rgb(0_0_0/0.07)_1px,transparent_1px)] md:bg-size-[22px_22px] md:px-6 md:py-10 lg:px-8 lg:py-12 lg:[--tm-half:1.75rem] md:dark:border-zinc-800 md:dark:bg-zinc-900/40 md:dark:bg-[radial-gradient(circle,rgb(255_255_255/0.06)_1px,transparent_1px)]"
        >
          {/* Goal node */}
          <div className="relative md:w-36 md:shrink-0 lg:w-40">
            <div className="rounded-[1.75rem] bg-gradient-to-br from-indigo-600 to-violet-600 px-5 py-4 text-center text-base font-semibold leading-snug text-white shadow-lg shadow-indigo-500/20 [overflow-wrap:anywhere] md:px-6 dark:from-indigo-500 dark:to-violet-500 dark:shadow-indigo-950/40">
              {goalTitle}
            </div>
            <span
              aria-hidden
              className={`absolute left-full top-[calc(50%-1px)] hidden h-0.5 w-[calc(var(--tm-half)+2px)] md:block ${TRUNK}`}
            />
          </div>
  
          {/* Main topics */}
          <ol className="pl-10 pt-3 md:ml-[calc(var(--tm-half)*2)] md:pl-0 md:pt-0">
            {tree.map((node, i) => {
              const accent = accentFor(i);
              const selected = selectedId === node.id;
              return (
                <li key={node.id} className="relative pb-3 md:flex md:items-center md:py-2">
                  <span aria-hidden className={`absolute w-0.5 ${TRUNK} ${segment(i, tree.length, "main")}`} />
                  <span aria-hidden className={`absolute h-0.5 ${TRUNK} ${stub("main")}`} />
                  <button
                    type="button"
                    data-topic-id={node.id}
                    aria-expanded={selected}
                    aria-controls={panelId}
                    onClick={(e) => open(node.id, e.currentTarget)}
                    className={`group relative flex w-full items-start gap-3 rounded-xl border-l-4 text-left shadow-sm transition hover:-translate-y-px hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-white motion-reduce:transition-none motion-reduce:hover:translate-y-0 md:w-56 md:shrink-0 md:items-center lg:w-64 xl:w-72 dark:focus-visible:ring-offset-zinc-950 ${accent.edge} ${accent.ring} ${
                      // Selection: tinted fill and a 2px accent border (padding
                      // shrinks by 1px so the card does not move). Focus keeps the ring.
                      selected
                        ? `border-2 py-[11px] pl-3 pr-[11px] ${accent.cardSelected}`
                        : "border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900"
                    }`}
                  >
                    <span
                      className={`grid size-7 shrink-0 place-items-center rounded-full text-sm font-bold tabular-nums ${accent.badge}`}
                    >
                      {i + 1}
                    </span>{" "}
                    <span className="min-w-0 pt-0.5 md:pt-0">
                      <span className="block text-[15px] font-medium leading-6 text-zinc-900 [overflow-wrap:anywhere] md:leading-snug dark:text-zinc-100">
                        {node.title}
                      </span>
                      {coverage?.[node.id] && <CoverageBadge state={coverage[node.id].state} className="mt-1" />}
                    </span>
                    {node.children.length > 0 && (
                      <span
                        aria-hidden
                        className={`absolute left-full top-[calc(50%-1px)] hidden h-0.5 w-[calc(var(--tm-half)+2px)] md:block ${accent.line}`}
                      />
                    )}
                  </button>
  
                  {node.children.length > 0 && (
                    <ol className="ml-[29px] pl-5 pt-2 md:ml-[calc(var(--tm-half)*2)] md:w-48 md:shrink-0 md:pl-0 md:pt-0 lg:w-56">
                      {node.children.map((child, j) => {
                        const childSelected = selectedId === child.id;
                        return (
                          <li key={child.id} className="relative pb-2 last:pb-0 md:py-1 md:last:py-1">
                            <span
                              aria-hidden
                              className={`absolute w-0.5 ${accent.line} ${segment(j, node.children.length, "child")}`}
                            />
                            <span aria-hidden className={`absolute h-0.5 ${accent.line} ${stub("child")}`} />
                            <button
                              type="button"
                              data-topic-id={child.id}
                              aria-expanded={childSelected}
                              aria-controls={panelId}
                              onClick={(e) => open(child.id, e.currentTarget)}
                              className={`max-w-full rounded-lg text-left text-sm leading-5 transition [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-white motion-reduce:transition-none dark:focus-visible:ring-offset-zinc-950 ${accent.chip} ${accent.ring} ${
                                childSelected
                                  ? `border-2 px-[11px] py-[5px] ${accent.chipSelected}`
                                  : `border px-3 py-1.5 ${accent.chipIdle}`
                              }`}
                            >
                              {child.title}
                              {coverage?.[child.id] && (
                                <>
                                  {" "}
                                  <CoverageBadge state={coverage[child.id].state} className="ml-1" />
                                </>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
  
        {selection && (
          <DetailPanel
            id={panelId}
            selection={selection}
            total={tree.length}
            goalTitle={goalTitle}
            coverage={coverage?.[selection.node.id]}
            panelRef={panelRef}
            onClose={close}
            onSelect={(id) => setSelectedId(id)}
          />
        )}
      </div>

      {selection && (
        <div
          aria-hidden
          onClick={close}
          className="fixed inset-0 z-30 bg-zinc-950/40 motion-safe:animate-[fade-in_150ms_ease-out] xl:hidden"
        />
      )}
    </div>
  );
}

function findSelection(tree: TreeNode[], id: string | null): Selection | null {
  if (!id) return null;
  for (const [i, node] of tree.entries()) {
    if (node.id === id) return { node, index: i, parent: null, branch: i };
    for (const [j, child] of node.children.entries()) {
      if (child.id === id) return { node: child, index: j, parent: node, branch: i };
    }
  }
  return null;
}

function DetailPanel({
  id,
  selection,
  total,
  goalTitle,
  coverage,
  panelRef,
  onClose,
  onSelect,
}: {
  id: string;
  selection: Selection;
  total: number;
  goalTitle: string;
  coverage?: NodeCoverage;
  panelRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const { node, index, parent, branch } = selection;
  const accent = accentFor(branch);
  return (
    <div
      ref={panelRef}
      id={id}
      role="dialog"
      aria-modal="false"
      aria-labelledby="topic-detail-title"
      tabIndex={-1}
      className="fixed inset-x-0 bottom-0 z-40 max-h-[70vh] overflow-y-auto rounded-t-2xl border-t border-zinc-200 bg-white p-6 shadow-[0_-12px_40px_-12px_rgb(0_0_0/0.25)] outline-none motion-safe:animate-sheet-in xl:sticky xl:top-6 xl:right-auto xl:bottom-auto xl:left-auto xl:z-auto xl:max-h-[calc(100vh-3rem)] xl:w-80 xl:shrink-0 xl:rounded-3xl xl:border xl:shadow-xl xl:shadow-zinc-950/5 xl:motion-safe:animate-panel-in dark:border-zinc-800 dark:bg-zinc-900 xl:dark:shadow-black/30"
    >
      <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-zinc-300 xl:hidden dark:bg-zinc-700" aria-hidden />
      <div className="flex items-start justify-between gap-4">
        <p className={`text-xs font-semibold uppercase tracking-wider ${accent.text}`}>
          {parent ? `Part of: ${parent.title}` : `Topic ${index + 1} of ${total}`}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="-mr-2 -mt-2 shrink-0 rounded-md px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          Close
        </button>
      </div>
      <h2
        id="topic-detail-title"
        className="mt-3 text-xl font-semibold leading-snug text-zinc-900 [overflow-wrap:anywhere] dark:text-zinc-50"
      >
        {node.title}
      </h2>
      <p className="mt-3 text-[15px] leading-relaxed text-zinc-700 dark:text-zinc-300">
        {node.summary ?? <span className="italic text-zinc-500 dark:text-zinc-400">No summary yet.</span>}
      </p>
      {coverage && (
        <div className="mt-6">
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Your sources <CoverageBadge state={coverage.state} className="normal-case tracking-normal" />
          </h3>
          {coverage.sources.length > 0 && (
            <ul className="mt-3 flex flex-col gap-3">
              {coverage.sources.map((src, i) => (
                <li key={i} className="text-sm">
                  <p className="font-medium text-zinc-900 [overflow-wrap:anywhere] dark:text-zinc-100">{src.title}</p>
                  <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">{LABEL_TEXT[src.label]}</p>
                  <p className="mt-0.5 text-zinc-700 dark:text-zinc-300">{src.reason}</p>
                </li>
              ))}
            </ul>
          )}
          {coverage.state !== "covered" && (
            <div className="mt-3">
              <SearchLinks query={searchQuery(goalTitle, node.title)} />
            </div>
          )}
        </div>
      )}
      {!parent && node.children.length > 0 && (
        <div className="mt-8">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            In this topic
          </h3>
          <ul className="mt-3 flex flex-col gap-2">
            {node.children.map((child) => (
              <li key={child.id}>
                <button
                  type="button"
                  onClick={() => onSelect(child.id)}
                  className={`w-full rounded-lg border px-3 py-2 text-left text-sm leading-5 transition focus-visible:outline-none focus-visible:ring-2 motion-reduce:transition-none ${accent.chip} ${accent.chipIdle} ${accent.ring}`}
                >
                  {child.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {parent && (
        <button
          type="button"
          onClick={() => onSelect(parent.id)}
          className="mt-8 text-sm font-medium text-zinc-600 underline-offset-4 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          ← Back to {parent.title}
        </button>
      )}
    </div>
  );
}
