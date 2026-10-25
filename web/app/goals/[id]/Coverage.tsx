import { StatusChip } from "@/components/ui/chips";
import type { CoverageState } from "@/lib/sources";

export function CoverageBadge({ state, className = "" }: { state: CoverageState; className?: string }) {
  return <StatusChip kind="coverage" value={state} className={className} />;
}
