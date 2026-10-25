"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@/lib/supabase/client";
import { SOURCE_COLUMNS, type SourceRow } from "@/lib/sources";

const busy = (s: SourceRow) => s.status === "queued" || s.status === "processing" || s.status === "awaiting_map";
const isDiscovering = (status: string | null | undefined) => status === "waiting" || status === "running";

/**
 * A goal's sources, kept live while any are being processed or sources are still being found
 * for it. Live steps come from polling just the source rows (and the goal's discovery status).
 * The page is refreshed (for coverage and the map) only when a source finishes or discovery
 * ends, not every 2 s, which raced React's commits.
 */
export function useSourceRows(
  goalId: string,
  initial: SourceRow[],
  initialDiscovering = false,
): { rows: SourceRow[]; discovering: boolean } {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [discovering, setDiscovering] = useState(initialDiscovering);
  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial !== prevInitial) {
    // New server data after a refresh replaces the polled rows.
    setPrevInitial(initial);
    setRows(initial);
    setDiscovering(initialDiscovering);
  }
  const busyCount = rows.filter(busy).length;

  useEffect(() => {
    if (busyCount === 0 && !discovering) return;
    const supabase = createBrowserClient();
    let stopped = false;
    const timer = setInterval(async () => {
      const [{ data }, { data: goal }] = await Promise.all([
        supabase
          .from("sources")
          .select(SOURCE_COLUMNS)
          .eq("goal_id", goalId)
          .order("created_at", { ascending: false })
          .order("id"),
        discovering
          ? supabase.from("goals").select("discovery_status").eq("id", goalId).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);
      if (stopped || !data) return;
      const next = data as SourceRow[];
      setRows(next);
      const stillDiscovering = discovering && isDiscovering(goal?.discovery_status);
      if (discovering && !stillDiscovering) setDiscovering(false);
      if (next.filter(busy).length < busyCount || (discovering && !stillDiscovering)) {
        stopped = true;
        clearInterval(timer);
        router.refresh();
      }
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [busyCount, discovering, goalId, router]);

  return { rows, discovering };
}
