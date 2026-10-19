"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { button } from "@/components/ui/buttons";
import { StatusChip } from "@/components/ui/chips";
import { Icon } from "@/components/ui/icon";
import { MasteryMeter } from "@/components/ui/mastery-meter";
import type { MasteryLabel } from "@/lib/quiz";
import type { NodeCoverage } from "@/lib/sources";
import type { TreeNode } from "@/lib/topic-tree";
import { useAddSource } from "./add-source-context";

export type Level = "beginner" | "intermediate" | "advanced";
type Mastery = Record<string, { decayed: number; label: MasteryLabel }>;

const LINE = "bg-outline-variant";

/*
 * Connector geometry. Every connector is an absolutely positioned 2px span.
 * Mobile: a vertical tree. Main topics hang off a trunk 20px left of the list
 * (the list has 40px left padding), level with each card's first line (25px
 * down). Children hang off a trunk under their parent's number.
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
      : `left-[-20px] ${first ? "top-[-8px]" : "top-0"} ${last ? (first ? "h-[31px]" : "h-[23px]") : "bottom-0"}`;
  const desktop =
    count === 1
      ? "md:hidden"
      : `md:left-[calc(var(--tm-half)*-1)] ${first ? "md:top-1/2" : "md:top-0"} ${last ? "md:bottom-1/2 md:h-auto" : "md:bottom-0"}`;
  return `${mobile} ${desktop}`;
}

/** Horizontal stub from the trunk to item's left edge. */
function stub(kind: "main" | "child") {
  return `left-[-20px] w-5 ${kind === "main" ? "top-[25px]" : "top-[22px]"} md:left-[calc(var(--tm-half)*-1)] md:w-(--tm-half) md:top-[calc(50%-1px)]`;
}

const CARD =
  "relative block w-full rounded-xl text-left transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary";
// Selection: a 2px primary border and tonal fill (padding shrinks by 1px so the card doesn't move).
const IDLE = "border border-outline-variant bg-surface hover:bg-on-surface/4";
const SELECTED = "border-2 border-primary bg-primary-container text-on-primary-container";

type Selection = { node: TreeNode; index: number; parent: TreeNode | null };

export function TopicMap({
  goalId,
  goalTitle,
  tree,
  coverage,
  mastery,
}: {
  goalId: string;
  goalTitle: string;
  tree: TreeNode[];
  /** Per-subtopic coverage; chips show only when given (the goal has a ready source). */
  coverage?: Record<string, NodeCoverage>;
  /** Per-subtopic decayed mastery; a bar shows on topics the learner has practised. */
  mastery?: Mastery;
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

  // Move focus into the panel whenever its topic changes, and on wide screens keep
  // the selected node in view (the map scrolls inside its own box when space is short).
  // The panel is a column beside the map on wide screens and a bottom sheet below.
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
      // A modal dialog (Add source) handles its own Esc.
      if (e.key === "Escape" && !document.querySelector("dialog[open]")) {
        setSelectedId(null);
        openerRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedId]);

  return (
    <div>
      <div className="xl:flex xl:items-start xl:gap-6">
        <nav
          aria-label="Topic map"
          className="[--tm-half:1.25rem] md:flex md:w-fit md:min-w-0 md:max-w-full md:items-center md:scroll-p-6 md:overflow-x-auto md:py-2 lg:[--tm-half:1.5rem]"
        >
          {/* Goal node */}
          <div className="relative md:w-36 md:shrink-0">
            <div className="rounded-2xl bg-surface-container-highest px-4 py-4 text-title-m text-on-surface [overflow-wrap:anywhere]">
              {goalTitle}
            </div>
            <span
              aria-hidden
              className={`absolute left-full top-[calc(50%-1px)] hidden h-0.5 w-[calc(var(--tm-half)+2px)] md:block ${LINE}`}
            />
          </div>

          {/* Main topics */}
          <ol className="pl-10 pt-3 md:ml-[calc(var(--tm-half)*2)] md:pl-0 md:pt-0">
            {tree.map((node, i) => {
              const selected = selectedId === node.id;
              return (
                <li key={node.id} className="relative pb-3 md:flex md:items-center md:py-2">
                  <span aria-hidden className={`absolute w-0.5 ${LINE} ${segment(i, tree.length, "main")}`} />
                  <span aria-hidden className={`absolute h-0.5 ${LINE} ${stub("main")}`} />
                  <button
                    type="button"
                    data-topic-id={node.id}
                    aria-expanded={selected}
                    aria-controls={panelId}
                    onClick={(e) => open(node.id, e.currentTarget)}
                    className={`${CARD} md:w-60 md:shrink-0 ${selected ? `p-[13px] ${SELECTED}` : `p-3.5 ${IDLE}`}`}
                  >
                    <span className="flex gap-2 text-title-m [overflow-wrap:anywhere]">
                      <span className="tabular-nums">{i + 1}</span> <span className="min-w-0">{node.title}</span>
                    </span>
                    <NodeStatus id={node.id} coverage={coverage} mastery={mastery} />
                    {node.children.length > 0 && (
                      <span
                        aria-hidden
                        className={`absolute left-full top-[calc(50%-1px)] hidden h-0.5 w-[calc(var(--tm-half)+2px)] md:block ${LINE}`}
                      />
                    )}
                  </button>

                  {node.children.length > 0 && (
                    <ol className="ml-6 pl-5 pt-2 md:ml-[calc(var(--tm-half)*2)] md:w-44 md:shrink-0 md:pl-0 md:pt-0">
                      {node.children.map((child, j) => {
                        const childSelected = selectedId === child.id;
                        return (
                          <li key={child.id} className="relative pb-2 last:pb-0 md:py-1 md:last:py-1">
                            <span
                              aria-hidden
                              className={`absolute w-0.5 ${LINE} ${segment(j, node.children.length, "child")}`}
                            />
                            <span aria-hidden className={`absolute h-0.5 ${LINE} ${stub("child")}`} />
                            <button
                              type="button"
                              data-topic-id={child.id}
                              aria-expanded={childSelected}
                              aria-controls={panelId}
                              onClick={(e) => open(child.id, e.currentTarget)}
                              className={`${CARD} ${childSelected ? `p-[11px] ${SELECTED}` : `p-3 ${IDLE}`}`}
                            >
                              <span className="block text-body-m font-medium [overflow-wrap:anywhere]">
                                {child.title}
                              </span>
                              <NodeStatus id={child.id} coverage={coverage} mastery={mastery} />
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
            goalId={goalId}
            coverage={coverage?.[selection.node.id]}
            mastery={mastery?.[selection.node.id]}
            panelRef={panelRef}
            onClose={close}
            onLeave={() => setSelectedId(null)}
          />
        )}
      </div>

      {selection && (
        <div
          aria-hidden
          onClick={close}
          className="fixed inset-0 z-30 bg-scrim motion-safe:animate-[fade-in_150ms_ease-out] xl:hidden"
        />
      )}
    </div>
  );
}

/** A card's coverage chip and mastery meter, when known. */
function NodeStatus({ id, coverage, mastery }: { id: string; coverage?: Record<string, NodeCoverage>; mastery?: Mastery }) {
  if (!coverage?.[id] && !mastery?.[id]) return null;
  return (
    <>
      {coverage?.[id] && (
        <span className="mt-2 block">
          <StatusChip kind="coverage" value={coverage[id].state} />
        </span>
      )}
      {mastery?.[id] && <MasteryMeter {...mastery[id]} className="mt-3" />}
    </>
  );
}

function findSelection(tree: TreeNode[], id: string | null): Selection | null {
  if (!id) return null;
  for (const [i, node] of tree.entries()) {
    if (node.id === id) return { node, index: i, parent: null };
    for (const [j, child] of node.children.entries()) {
      if (child.id === id) return { node: child, index: j, parent: node };
    }
  }
  return null;
}

function DetailPanel({
  id,
  selection,
  goalId,
  coverage,
  mastery,
  panelRef,
  onClose,
  onLeave,
}: {
  id: string;
  selection: Selection;
  goalId: string;
  coverage?: NodeCoverage;
  mastery?: { decayed: number; label: MasteryLabel };
  panelRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  /** Following a link in the panel to another page (lesson, quiz). */
  onLeave: () => void;
}) {
  const addSource = useAddSource();
  const { node, index, parent } = selection;
  const gap = coverage?.state === "gap";
  const lessonHref = `/goals/${goalId}/topics/${node.id}`;
  return (
    <div
      ref={panelRef}
      id={id}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${id}-title`}
      tabIndex={-1}
      // Next keeps this page's state when the learner comes back, so close the panel on the
      // way out; otherwise it would reopen beside the map.
      onClickCapture={(e) => {
        const link = (e.target as HTMLElement).closest("a");
        if (link && link.target !== "_blank") onLeave();
      }}
      className="fixed inset-x-0 bottom-0 z-40 max-h-[70vh] overflow-y-auto rounded-t-3xl bg-surface-container-high p-6 text-on-surface outline-none motion-safe:animate-sheet-in xl:sticky xl:top-6 xl:bottom-auto xl:z-auto xl:w-72 xl:shrink-0 xl:rounded-2xl xl:p-5 xl:motion-safe:animate-none"
    >
      <div className="mx-auto mb-4 h-1 w-8 rounded-full bg-outline xl:hidden" aria-hidden />
      {parent && <p className="text-label-m text-on-surface-variant [overflow-wrap:anywhere]">Part of: {parent.title}</p>}
      <div className="flex items-start justify-between gap-2">
        <h2 id={`${id}-title`} className="min-w-0 pt-2 text-title-l [overflow-wrap:anywhere]">
          {parent ? node.title : `${index + 1} ${node.title}`}
        </h2>
        <button type="button" aria-label="Close" onClick={onClose} className={button("icon", "-mr-3 -mt-1")}>
          <Icon name="close" size={24} />
        </button>
      </div>
      {(coverage || mastery) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {coverage && <StatusChip kind="coverage" value={coverage.state} />}
          {mastery && <StatusChip kind="mastery" value={mastery.label} />}
        </div>
      )}
      <p className="mt-3 text-body-m text-on-surface-variant">
        {node.summary ?? <span className="italic">No summary yet.</span>}
      </p>
      {gap && addSource ? (
        <>
          <p className="mt-4 text-body-m text-on-surface-variant">Add a source on this topic to build its lesson.</p>
          <button type="button" onClick={addSource} className={button("outlined", "mt-4 w-full")}>
            <Icon name="add" />
            Add source
          </button>
        </>
      ) : (
        <div className="mt-5 flex flex-col gap-2">
          <Link href={lessonHref} className={button("tonal")}>
            <Icon name="menu_book" />
            Open lesson
          </Link>
          <Link href={`${lessonHref}/quiz`} className={button("outlined")}>
            <Icon name="quiz" />
            Quiz me
          </Link>
        </div>
      )}
    </div>
  );
}
