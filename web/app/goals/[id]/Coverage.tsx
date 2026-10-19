import { StatusChip } from "@/components/ui/chips";
import type { CoverageState } from "@/lib/sources";

export function CoverageBadge({ state, className = "" }: { state: CoverageState; className?: string }) {
  return <StatusChip kind="coverage" value={state} className={className} />;
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
