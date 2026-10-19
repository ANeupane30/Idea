import { LABEL_TEXT, type MasteryLabel } from "@/lib/quiz";
import { Icon, type IconName } from "./icon";

const SIGNAL: Record<MasteryLabel, IconName> = {
  strong: "signal_cellular_alt",
  developing: "signal_cellular_alt_2_bar",
  weak: "signal_cellular_alt_1_bar",
};

/** A 4px bar whose length shows decayed mastery, then the label's signal icon and word. */
export function MasteryMeter({
  decayed,
  label,
  showLabel = true,
  className = "",
}: {
  decayed: number;
  label: MasteryLabel;
  showLabel?: boolean;
  className?: string;
}) {
  return (
    <span role="img" aria-label={`Mastery: ${LABEL_TEXT[label]}`} className={`flex items-center gap-2 ${className}`}>
      <span className="block h-1 min-w-12 flex-1 overflow-hidden rounded-full bg-outline-variant">
        <span
          data-fill
          className="block h-full rounded-full bg-primary"
          style={{ width: `${Math.max(4, Math.round(decayed * 100))}%` }}
        />
      </span>
      {showLabel && (
        <span className="inline-flex shrink-0 items-center gap-0.5 text-label-m text-on-surface-variant">
          <Icon name={SIGNAL[label]} size={16} />
          {LABEL_TEXT[label]}
        </span>
      )}
    </span>
  );
}
