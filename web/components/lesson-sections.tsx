"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import { Icon, type IconName } from "@/components/ui/icon";
import type { LessonSource, Section } from "@/lib/lessons";

const TYPE_ICON: Record<string, IconName> = { web: "article", youtube: "smart_display", pdf: "picture_as_pdf" };

const CHIP =
  "inline-grid h-5 min-w-5 place-items-center rounded-full bg-surface-container-highest px-1.5 align-[0.1em] text-[11px] leading-none font-medium text-on-surface-variant";

/**
 * A lesson's sections, then its numbered sources. Markdown comes from the model (and indirectly
 * from sources), so it is rendered without raw HTML, and react-markdown's URL transform drops
 * javascript: links.
 */
export function LessonSections({ sections, sources }: { sections: Section[]; sources: LessonSource[] }) {
  const byNumber = new Map(sources.map((s) => [s.n, s]));
  return (
    <div aria-label="Lesson" className="flex flex-col gap-8">
      {sections.map((section, i) => (
        <section key={i}>
          <div className="lesson-prose text-body-l text-on-surface [overflow-wrap:anywhere] [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-surface-container-high [&_code]:px-1 [&_code]:text-[14px] [&_h2]:mb-2 [&_h2]:text-headline-s [&_h3]:mb-2 [&_h3]:text-title-l [&_li]:mb-1 [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:mb-3 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-6">
            {/* No images: a source could steer the model into a tracking pixel. */}
            <ReactMarkdown remarkPlugins={[remarkGfm]} disallowedElements={["img"]}>
              {section.markdown}
            </ReactMarkdown>
          </div>
          {section.mermaid && <MermaidDiagram code={section.mermaid} />}
          {section.citations.length > 0 && (
            <p className="mt-2 flex flex-wrap gap-1.5">
              {section.citations.map((n) => {
                const src = byNumber.get(n);
                if (!src) return null;
                const detail = [src.title, src.label].filter(Boolean).join(" · ");
                return src.href ? (
                  <a
                    key={n}
                    href={src.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={detail}
                    aria-label={`Source ${n}: ${src.title}`}
                    className={`${CHIP} hover:bg-primary-container hover:text-on-primary-container focus-visible:outline-3 focus-visible:outline-primary`}
                  >
                    {n}
                  </a>
                ) : (
                  <span key={n} title={detail} className={CHIP}>
                    <span aria-hidden>{n}</span>
                    <span className="sr-only">
                      Source {n}: {src.title}
                    </span>
                  </span>
                );
              })}
            </p>
          )}
        </section>
      ))}
      {sources.length > 0 && <SourceNotes sources={sources} />}
    </div>
  );
}

/** The numbered sources under a lesson: title (linked when it has a page) and where in it. */
function SourceNotes({ sources }: { sources: LessonSource[] }) {
  return (
    <div className="border-t border-outline-variant pt-6">
      <h2 className="text-label-l text-on-surface-variant">Sources</h2>
      <ol className="mt-3 flex flex-col gap-3">
        {sources.map((s) => (
          <li key={s.n} className="flex items-center gap-3 text-body-m text-on-surface-variant">
            <span aria-hidden className={CHIP}>
              {s.n}
            </span>
            <Icon name={TYPE_ICON[s.type] ?? "article"} size={18} />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {s.href ? (
                <a
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-2"
                >
                  {s.title}
                </a>
              ) : (
                <span className="text-on-surface">{s.title}</span>
              )}
              {s.label && <> · {s.label}</>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
