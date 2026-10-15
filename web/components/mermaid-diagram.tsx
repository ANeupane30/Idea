"use client";

import { useEffect, useId, useRef, useState } from "react";

/** Renders a Mermaid diagram in strict mode (no click handlers or HTML labels). Errors render nothing. */
export function MermaidDiagram({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = `m${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
        const { svg } = await mermaid.render(id, code);
        if (!cancelled && ref.current) ref.current.innerHTML = svg;
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, id]);

  if (failed) return null;
  return (
    <figure aria-label="Diagram" className="mt-4 overflow-x-auto rounded-xl bg-zinc-50 p-4 dark:bg-zinc-950/60">
      <div ref={ref} className="flex justify-center [&_svg]:h-auto [&_svg]:max-w-full" />
    </figure>
  );
}
