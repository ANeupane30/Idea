"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@/lib/supabase/client";
import { SOURCE_COLUMNS, type SourceRow } from "@/lib/sources";

const busy = (s: SourceRow) => s.status === "queued" || s.status === "processing";

/**
 * A goal's sources, kept live while any are being processed. Live steps come from polling just
 * the source rows. The page is refreshed (for coverage and the map) only when a source finishes,
 * not every 2 s, which raced React's commits.
 */
export function useSourceRows(goalId: string, initial: SourceRow[]): SourceRow[] {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial !== prevInitial) {
    // New server data after a refresh replaces the polled rows.
    setPrevInitial(initial);
    setRows(initial);
  }
  const busyCount = rows.filter(busy).length;

  useEffect(() => {
    if (busyCount === 0) return;
    const supabase = createBrowserClient();
    let stopped = false;
    const timer = setInterval(async () => {
      const { data } = await supabase
        .from("sources")
        .select(SOURCE_COLUMNS)
        .eq("goal_id", goalId)
        .order("created_at", { ascending: false })
        .order("id");
      if (stopped || !data) return;
      const next = data as SourceRow[];
      setRows(next);
      if (next.filter(busy).length < busyCount) {
        stopped = true;
        clearInterval(timer);
        router.refresh();
      }
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [busyCount, goalId, router]);

  return rows;
}
