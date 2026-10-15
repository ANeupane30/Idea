"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import type { LessonSource, Section } from "@/lib/lessons";

/**
 * A lesson's sections. Markdown comes from the model (and indirectly from sources), so it is
 * rendered without raw HTML, and react-markdown's URL transform drops javascript: links.
 */
export function LessonSections({ sections, sources }: { sections: Section[]; sources: LessonSource[] }) {
  const byNumber = new Map(sources.map((s) => [s.n, s]));
  return (
    <div aria-label="Lesson" className="flex flex-col gap-6">
      {sections.map((section, i) => (
        <section
          key={i}
          className="rounded-2xl border border-zinc-200 bg-white p-5 sm:p-6 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <div className="lesson-prose text-[15px] leading-relaxed text-zinc-800 dark:text-zinc-200 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-zinc-900 dark:[&_h2]:text-zinc-50 [&_h3]:mb-2 [&_h3]:font-semibold [&_p]:mb-3 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_code]:rounded [&_code]:bg-zinc-100 [&_code]:px-1 [&_code]:text-[13px] dark:[&_code]:bg-zinc-800 [&_a]:text-indigo-700 [&_a]:underline dark:[&_a]:text-indigo-300 [overflow-wrap:anywhere]">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{section.markdown}</ReactMarkdown>
          </div>
          {section.mermaid && <MermaidDiagram code={section.mermaid} />}
          <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="font-semibold uppercase tracking-wider">Sources:</span>
            {section.citations.map((n) => {
              const src = byNumber.get(n);
              if (!src) return null;
              const detail = [src.title, src.label].filter(Boolean).join(", ");
              return src.href ? (
                <a
                  key={n}
                  href={src.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={detail}
                  className="font-medium text-indigo-700 hover:underline dark:text-indigo-300"
                >
                  [{n}]
                </a>
              ) : (
                <span key={n}>
                  [{n}] {detail}
                </span>
              );
            })}
          </p>
        </section>
      ))}
    </div>
  );
}
