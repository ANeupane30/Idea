import type { SourceRow } from "@/lib/sources";

/** Statuses while a goal is prepared; its map is shown only at "ready". */
export const PREP_STATUSES = [
  "pending",
  "understanding",
  "finding_sources",
  "reading_sources",
  "checking_sources",
  "building_map",
  "matching_sources",
] as const;

export function isPreparing(status: string): boolean {
  return (PREP_STATUSES as readonly string[]).includes(status);
}

const DONE_READING = new Set(["awaiting_map", "ready"]);

/** Main topics with a source (covered or thin), out of all main topics ("Preparing lessons: k of m"). */
export function topicsReady(
  mainTopics: { id: string }[],
  states: { subtopic_id: string; state: string }[],
): { ready: number; total: number } {
  const state = new Map(states.map((s) => [s.subtopic_id, s.state]));
  const ready = mainTopics.filter((t) => (state.get(t.id) ?? "gap") !== "gap").length;
  return { ready, total: mainTopics.length };
}

function where(s: SourceRow): string {
  if (s.type === "outline") return "your outline";
  try {
    return new URL(s.url_or_file).hostname.replace(/^www\./, "");
  } catch {
    return s.file_name ?? "a file";
  }
}

/** The line shown for the stage a goal is in, with counts (see the sources-first spec, §3). */
export function stageText(status: string, sources: SourceRow[], topics: { ready: number; total: number } | null): string {
  switch (status) {
    case "understanding":
      return "Understanding your goal…";
    case "finding_sources":
      return "Finding learning material for your goal…";
    case "reading_sources": {
      const live = sources.filter((s) => s.status !== "failed");
      const n = live.length;
      const done = live.filter((s) => DONE_READING.has(s.status)).length;
      const next = live.find((s) => !DONE_READING.has(s.status));
      const i = Math.min(done + 1, n);
      return next ? `Reading ${i} of ${n} sources: ${where(next)}…` : `Reading ${i} of ${n} sources…`;
    }
    case "checking_sources":
      return `Checking ${sources.filter((s) => s.status === "awaiting_map").length} sources…`;
    case "matching_sources":
      return topics ? `Preparing lessons: ${topics.ready} of ${topics.total} topics ready` : "Preparing lessons…";
    default:
      return "Designing your map…";
  }
}
