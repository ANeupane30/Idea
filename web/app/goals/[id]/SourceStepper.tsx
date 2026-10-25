import { Icon } from "@/components/ui/icon";
import { STAGE_TEXT } from "@/lib/sources";

/** A source's progress through Fetching, Reading, Matching to your topics and Ready. */
export function SourceStepper({ stage }: { stage: number }) {
  return (
    <ol aria-label="Progress" className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-label-m">
      {STAGE_TEXT.map((text, i) => (
        <li
          key={text}
          aria-current={i === stage ? "step" : undefined}
          className={`flex items-center gap-1 ${i === stage ? "text-primary" : "text-on-surface-variant"}`}
        >
          <Icon
            name={i < stage ? "check_circle" : i === stage ? "progress_activity" : "radio_button_unchecked"}
            filled={i < stage}
            size={16}
            className={i === stage ? "motion-safe:animate-spin" : ""}
          />
          {text}
        </li>
      ))}
    </ol>
  );
}
