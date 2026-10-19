import type { MasteryLabel } from "@/lib/quiz";
import type { CoverageState, RelevanceLabel } from "@/lib/sources";
import { Icon, type IconName } from "./icon";

type Tone = "positive" | "partial" | "negative";

const TONE: Record<Tone, string> = {
  positive: "bg-positive text-on-positive",
  partial: "bg-partial text-on-partial",
  negative: "bg-negative text-on-negative",
};

type Spec = { word: string; icon: IconName; tone: Tone };

const SPECS = {
  coverage: {
    covered: { word: "Covered", icon: "check_circle", tone: "positive" },
    thin: { word: "Thin", icon: "contrast", tone: "partial" },
    gap: { word: "Gap", icon: "radio_button_unchecked", tone: "negative" },
  },
  relevance: {
    high: { word: "Highly relevant", icon: "check_circle", tone: "positive" },
    partial: { word: "Partly relevant", icon: "contrast", tone: "partial" },
    off_topic: { word: "Off-topic", icon: "block", tone: "negative" },
  },
  mastery: {
    strong: { word: "Strong", icon: "signal_cellular_alt", tone: "positive" },
    developing: { word: "Developing", icon: "signal_cellular_alt_2_bar", tone: "partial" },
    weak: { word: "Weak", icon: "signal_cellular_alt_1_bar", tone: "negative" },
  },
  answer: {
    correct: { word: "Correct", icon: "check", tone: "positive" },
    wrong: { word: "Not quite", icon: "close", tone: "negative" },
  },
} satisfies Record<string, Record<string, Spec>>;

type Props =
  | { kind: "coverage"; value: CoverageState }
  | { kind: "relevance"; value: RelevanceLabel }
  | { kind: "mastery"; value: MasteryLabel }
  | { kind: "answer"; value: "correct" | "wrong" };

/** A status: icon plus word, never colour alone. */
export function StatusChip({ kind, value, className = "" }: Props & { className?: string }) {
  const spec: Spec = (SPECS[kind] as Record<string, Spec>)[value];
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-lg px-2 text-label-m whitespace-nowrap ${TONE[spec.tone]} ${className}`}
    >
      <Icon name={spec.icon} size={16} filled={spec.icon === "check_circle"} />
      {spec.word}
    </span>
  );
}

/** A neutral tonal chip, e.g. "Beginner" or "Due for review". */
export function InfoChip({ icon, children, className = "" }: { icon?: IconName; children: React.ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-surface-container-high px-3 text-label-l text-on-surface-variant ${className}`}
    >
      {icon && <Icon name={icon} size={18} />}
      {children}
    </span>
  );
}

/**
 * A filter chip over a visually hidden radio or checkbox; shows a check when selected.
 * Pass the input's props; the chip's accessible name is `label`.
 */
export function FilterChip({
  label,
  ...input
}: { label: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "className">) {
  return (
    <label className="group relative inline-flex min-h-12 cursor-pointer items-center">
      <input {...input} className="peer sr-only" />
      <span className="inline-flex h-9 items-center gap-2 rounded-full border border-outline px-4 text-label-l text-on-surface-variant transition-colors group-hover:bg-on-surface/8 peer-checked:border-transparent peer-checked:bg-secondary-container peer-checked:pl-3 peer-checked:text-on-secondary-container peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary [&>svg]:hidden peer-checked:[&>svg]:block">
        <Icon name="check" size={18} />
        {label}
      </span>
    </label>
  );
}
