"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { buildTree, type SubtopicRow, type TreeNode } from "@/lib/topic-tree";
import type { ActionResult } from "@/lib/validation";
import { addSubtopic, deleteSubtopic, moveSubtopic, renameSubtopic } from "./map-actions";

const btn = "rounded border border-zinc-400 px-2 py-0.5 text-xs disabled:opacity-50";

export function TopicMapEditor({
  goalId,
  rows,
  readOnly = false,
}: {
  goalId: string;
  rows: SubtopicRow[];
  readOnly?: boolean;
}) {
  const router = useRouter();
  const tree = buildTree(rows);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [adding, setAdding] = useState<string | null>(null); // "root" or a parent id
  const [newTitle, setNewTitle] = useState("");
  const [newSummary, setNewSummary] = useState("");
  const [confirming, setConfirming] = useState<TreeNode | null>(null);

  function run(action: () => Promise<ActionResult>, onOk?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onOk?.();
      router.refresh();
    });
  }

  function openAdd(key: string) {
    setAdding(key);
    setNewTitle("");
    setNewSummary("");
    setError(null);
  }

  function renderAddForm(parentKey: string, parentTitle: string | null) {
    const parentId = parentKey === "root" ? null : parentKey;
    const suffix = parentTitle ? ` of ${parentTitle}` : "";
    return (
      <form
        className="mt-2 flex flex-col gap-2 rounded border border-zinc-300 p-2"
        onSubmit={(e) => {
          e.preventDefault();
          run(
            () => addSubtopic(goalId, parentId, newTitle, newSummary),
            () => setAdding(null),
          );
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          {parentId ? `New child title${suffix}` : "New subtopic title"}
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            className="rounded border border-zinc-400 px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {parentId ? `New child summary (optional)${suffix}` : "New subtopic summary (optional)"}
          <input
            value={newSummary}
            onChange={(e) => setNewSummary(e.target.value)}
            className="rounded border border-zinc-400 px-2 py-1"
          />
        </label>
        <div className="flex gap-2">
          <button type="submit" disabled={isPending} className="rounded bg-zinc-900 px-3 py-1 text-sm text-white">
            Add
          </button>
          <button type="button" className={btn} onClick={() => setAdding(null)}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  function renderRow(n: TreeNode, siblings: TreeNode[], index: number, parent: TreeNode | null, parentIndex: number) {
    const level = parent ? 1 : 0;
    const prev = siblings[index - 1];
    const canIndent = !parent && n.children.length === 0 && index > 0;
    return (
      <li key={n.id} data-testid="topic-row" data-level={level} className="py-2">
        <div className="flex flex-wrap items-center gap-2">
          {renaming === n.id ? (
            <input
              autoFocus
              aria-label={`Title for ${n.title}`}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  run(
                    () => renameSubtopic(n.id, renameValue),
                    () => setRenaming(null),
                  );
                } else if (e.key === "Escape") {
                  setRenaming(null);
                  setError(null);
                }
              }}
              className="rounded border border-zinc-400 px-2 py-0.5"
            />
          ) : (
            <span data-testid="topic-title" className="font-medium">
              {n.title}
            </span>
          )}
          {!readOnly && (
            <span className="flex flex-wrap gap-1">
              <button
                type="button"
                className={btn}
                disabled={isPending}
                aria-label={`Rename: ${n.title}`}
                onClick={() => {
                  setRenaming(n.id);
                  setRenameValue(n.title);
                  setError(null);
                }}
              >
                Rename
              </button>
              {index > 0 && (
                <button
                  type="button"
                  className={btn}
                  disabled={isPending}
                  aria-label={`Move up: ${n.title}`}
                  onClick={() => run(() => moveSubtopic(n.id, n.parent_id, index - 1))}
                >
                  Move up
                </button>
              )}
              {index < siblings.length - 1 && (
                <button
                  type="button"
                  className={btn}
                  disabled={isPending}
                  aria-label={`Move down: ${n.title}`}
                  onClick={() => run(() => moveSubtopic(n.id, n.parent_id, index + 1))}
                >
                  Move down
                </button>
              )}
              {canIndent && (
                <button
                  type="button"
                  className={btn}
                  disabled={isPending}
                  aria-label={`Indent: ${n.title}`}
                  onClick={() => run(() => moveSubtopic(n.id, prev.id, prev.children.length))}
                >
                  Indent
                </button>
              )}
              {parent && (
                <button
                  type="button"
                  className={btn}
                  disabled={isPending}
                  aria-label={`Outdent: ${n.title}`}
                  onClick={() => run(() => moveSubtopic(n.id, null, parentIndex + 1))}
                >
                  Outdent
                </button>
              )}
              {!parent && (
                <button
                  type="button"
                  className={btn}
                  disabled={isPending}
                  aria-label={`Add child: ${n.title}`}
                  onClick={() => openAdd(n.id)}
                >
                  Add child
                </button>
              )}
              <button
                type="button"
                className={btn}
                disabled={isPending}
                aria-label={`Delete: ${n.title}`}
                onClick={() => {
                  setError(null);
                  setConfirming(n);
                }}
              >
                Delete
              </button>
            </span>
          )}
        </div>
        {n.summary && <p className="text-sm text-zinc-600">{n.summary}</p>}
        {adding === n.id && renderAddForm(n.id, n.title)}
        {n.children.length > 0 && (
          <ul className="ml-6 mt-1 list-none border-l border-zinc-300 pl-3">
            {n.children.map((c, i) => renderRow(c, n.children, i, n, index))}
          </ul>
        )}
      </li>
    );
  }

  const confirmCount = confirming?.children.length ?? 0;

  return (
    <div className="mt-4">
      {error && (
        <p role="alert" className="mb-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <ul className="list-none">{tree.map((n, i) => renderRow(n, tree, i, null, i))}</ul>
      {!readOnly && (
        <div className="mt-3">
          {adding === "root" ? (
            renderAddForm("root", null)
          ) : (
            <button type="button" className="rounded border border-zinc-400 px-3 py-1" onClick={() => openAdd("root")}>
              Add subtopic
            </button>
          )}
        </div>
      )}
      {confirming && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-label="Confirm delete"
          className="fixed inset-0 z-10 flex items-center justify-center bg-black/40"
        >
          <div className="max-w-sm rounded bg-white p-4 shadow">
            <p>
              {confirmCount > 0
                ? `Delete ${confirming.title} and its ${confirmCount} ${confirmCount === 1 ? "subtopic" : "subtopics"}?`
                : `Delete ${confirming.title}?`}
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                autoFocus
                disabled={isPending}
                className="rounded bg-red-700 px-3 py-1 text-white"
                onClick={() => {
                  const id = confirming.id;
                  run(
                    () => deleteSubtopic(id),
                    () => setConfirming(null),
                  );
                }}
              >
                Confirm
              </button>
              <button type="button" className={btn} onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
