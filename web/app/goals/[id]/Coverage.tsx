import { button } from "@/components/ui/buttons";
import { StatusChip } from "@/components/ui/chips";
import { Icon } from "@/components/ui/icon";
import type { CoverageState } from "@/lib/sources";

export function CoverageBadge({ state, className = "" }: { state: CoverageState; className?: string }) {
  return <StatusChip kind="coverage" value={state} className={className} />;
}

/** "Try searching for:" with the query as a web-search chip and a YouTube chip. */
export function SearchLinks({ query }: { query: string }) {
  const q = encodeURIComponent(query);
  const chip = button("outlined", "min-h-10 max-w-full px-4 text-on-surface-variant");
  return (
    <div>
      <p className="text-body-m text-on-surface-variant">Try searching for:</p>
      <p className="mt-2 flex flex-wrap gap-2">
        <a
          className={chip}
          href={`https://www.google.com/search?q=${q}`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Search the web for ${query}`}
        >
          <Icon name="search" size={18} />
          <span className="min-w-0 truncate">{query}</span>
        </a>
        <a
          className={chip}
          href={`https://www.youtube.com/results?search_query=${q}`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Search YouTube for ${query}`}
        >
          <Icon name="smart_display" size={18} />
          YouTube
        </a>
      </p>
    </div>
  );
}
