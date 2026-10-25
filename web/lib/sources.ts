import { z } from "zod";
import type { TreeNode } from "@/lib/topic-tree";

/** Hosts the worker reads as YouTube videos (keep in step with worker/src/worker/ingest/urls.py). */
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

export const PDF_MAX_BYTES = 25 * 1024 * 1024;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** The only upload path accepted (database and worker check the same shape): <user id>/<uuid>.pdf. */
export function isUploadPath(userId: string, path: string): boolean {
  return new RegExp(`^${UUID}/${UUID}\.pdf$`).test(path) && path.startsWith(`${userId}/`);
}
export const PDF_TOO_BIG = "PDFs can be up to 25 MB.";
const LINK_MESSAGE = "Enter a link that starts with http:// or https://";

export function detectLinkType(url: string): "web" | "youtube" {
  try {
    return YOUTUBE_HOSTS.has(new URL(url).hostname.toLowerCase()) ? "youtube" : "web";
  } catch {
    return "web";
  }
}

/** A trimmed http(s) link of up to 2000 characters, returned in URL.href form (lowercase scheme and host). */
export const linkSchema = z
  .string()
  .trim()
  .max(2000, LINK_MESSAGE)
  .transform((value, ctx) => {
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") {
        if (url.href.length <= 2000) return url.href;
      }
    } catch {
      // fall through
    }
    ctx.addIssue({ code: "custom", message: LINK_MESSAGE });
    return z.NEVER;
  });

export type SourceStep = "queued" | "extracting" | "chunking" | "embedding" | "mapping";
export type RelevanceLabel = "high" | "partial" | "off_topic";

export const STEP_TEXT: Record<SourceStep, string> = {
  queued: "Waiting to start…",
  extracting: "Reading the source…",
  chunking: "Splitting into sections…",
  embedding: "Indexing…",
  mapping: "Matching to your topics…",
};

export const LABEL_TEXT: Record<RelevanceLabel, string> = {
  high: "Highly relevant",
  partial: "Partly relevant",
  off_topic: "Off-topic",
};

export const TYPE_TEXT: Record<string, string> = { web: "Web page", youtube: "YouTube", pdf: "PDF", outline: "Outline" };

/** The worker's message for a page behind a login (worker/src/worker/ingest/messages.py). */
export const PAYWALLED =
  "We can't read this page, it needs a login. Paste the course's syllabus or table of contents instead.";

export const OUTLINE_MAX = 20000;

/** A topic's main reference, as public.goal_main_references returns it. */
export type MainReferenceRow = {
  source_title: string;
  source_type: string;
  url_or_file: string;
  page: number | null;
  timestamp_start: number | null;
  anchor: string | null;
};

export type MainReference = { title: string; label: string; href: string | null };

function videoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1) || null;
    return u.searchParams.get("v") ?? (u.pathname.match(/^\/(?:shorts|embed)\/([\w-]+)/)?.[1] ?? null);
  } catch {
    return null;
  }
}

/** Its label and link, as the worker builds lesson citations (lessons/content.py). */
export function mainReference(r: MainReferenceRow): MainReference {
  if (r.source_type === "youtube") {
    const id = videoId(r.url_or_file);
    const s = Math.floor(Number(r.timestamp_start ?? 0));
    return {
      title: r.source_title,
      label: r.timestamp_start != null ? `at ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "",
      href: id ? `https://www.youtube.com/watch?v=${id}&t=${s}s` : null,
    };
  }
  if (r.source_type === "web") {
    return {
      title: r.source_title,
      label: "",
      href: r.anchor ? `${r.url_or_file}#:~:text=${encodeURIComponent(r.anchor)}` : r.url_or_file,
    };
  }
  // PDFs live in a private bucket; an outline is the learner's own text.
  return { title: r.source_title, label: r.source_type === "pdf" && r.page != null ? `page ${r.page}` : "", href: null };
}

export type SourceRow = {
  id: string;
  type: "web" | "youtube" | "pdf" | "outline";
  url_or_file: string;
  file_name: string | null;
  title: string | null;
  status: "queued" | "processing" | "awaiting_map" | "ready" | "failed";
  step: Exclude<SourceStep, "queued"> | null;
  delayed: boolean;
  error: string | null;
  relevance_label: RelevanceLabel | null;
  relevance_reason: string | null;
};

/** The four stages the Add source dialog shows. */
export const STAGE_TEXT = ["Fetching", "Reading", "Matching to your topics", "Ready"] as const;

const STEP_STAGE: Record<Exclude<SourceStep, "queued">, 0 | 1 | 2> = {
  extracting: 0,
  chunking: 1,
  embedding: 1,
  mapping: 2,
};

/** Which stage a source is at; a failed source keeps the stage it failed at. */
export function stageOf(row: Pick<SourceRow, "status" | "step">): { stage: 0 | 1 | 2 | 3; failed: boolean } {
  if (row.status === "ready") return { stage: 3, failed: false };
  // Read and indexed before the map existed: matching comes next.
  if (row.status === "awaiting_map") return { stage: 2, failed: false };
  return { stage: row.step ? STEP_STAGE[row.step] : 0, failed: row.status === "failed" };
}

export const SOURCE_COLUMNS =
  "id, type, url_or_file, file_name, title, status, step, delayed, error, relevance_label, relevance_reason";

// ------------------------------------------------------------- coverage

export type CoverageState = "covered" | "thin" | "gap";

export type NodeCoverage = {
  state: CoverageState;
  sources: { title: string; label: RelevanceLabel; reason: string }[];
};

export const COVERAGE_TEXT: Record<CoverageState, string> = { covered: "Covered", thin: "Thin", gap: "Gap" };

const LEADING_VERBS = /^(learn the basics of|learn about|learn|how to|understand|master)\s+/i;

/** The subject of a goal: "Learn the basics of personal finance" -> "personal finance". */
export function goalTopic(goalTitle: string): string {
  const title = goalTitle.trim();
  return title.replace(LEADING_VERBS, "").trim() || title;
}

export function searchQuery(goalTitle: string, subtopicTitle: string): string {
  return `${subtopicTitle} ${goalTopic(goalTitle)}`;
}

const ADD_NEXT_MAX = 5;

/** Gaps, then thin subtopics, in map order (each main topic, then its children); at most 5. */
export function addNextItems(tree: TreeNode[], coverage: Record<string, NodeCoverage>): TreeNode[] {
  const ordered = tree.flatMap((node) => [node, ...node.children]);
  const pick = (state: CoverageState) => ordered.filter((n) => coverage[n.id]?.state === state);
  return [...pick("gap"), ...pick("thin")].slice(0, ADD_NEXT_MAX);
}
