import { COVERAGE_TEXT, type CoverageState } from "@/lib/sources";

const BADGE_STYLE: Record<CoverageState, string> = {
  covered: "bg-emerald-100 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-200",
  thin: "bg-amber-100 text-amber-900 dark:bg-amber-400/15 dark:text-amber-200",
  gap: "bg-rose-100 text-rose-800 dark:bg-rose-400/15 dark:text-rose-200",
};

export function CoverageBadge({ state, className = "" }: { state: CoverageState; className?: string }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-px align-middle text-[11px] font-semibold leading-4 ${BADGE_STYLE[state]} ${className}`}
    >
      {COVERAGE_TEXT[state]}
    </span>
  );
}

/** "Try searching for: …" with web and YouTube search links. */
export function SearchLinks({ query }: { query: string }) {
  const q = encodeURIComponent(query);
  const link =
    "font-medium text-indigo-700 underline-offset-4 hover:underline dark:text-indigo-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded";
  return (
    <div className="text-sm">
      <p className="text-zinc-700 [overflow-wrap:anywhere] dark:text-zinc-300">Try searching for: {query}</p>
      <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        <a className={link} href={`https://www.google.com/search?q=${q}`} target="_blank" rel="noopener noreferrer">
          Search the web
        </a>
        <a
          className={link}
          href={`https://www.youtube.com/results?search_query=${q}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Search YouTube
        </a>
      </p>
    </div>
  );
}
