import { ICONS } from "./icons.generated";

export type IconName = keyof typeof ICONS;

// Partial signal icons get the full icon as a faded track, so one bar reads as "1 of 3", not a stray mark.
const TRACK: Partial<Record<IconName, IconName>> = {
  signal_cellular_alt_1_bar: "signal_cellular_alt",
  signal_cellular_alt_2_bar: "signal_cellular_alt",
};

/**
 * A Material Symbols Rounded icon as inline SVG. Always decorative: give the control
 * its name with text or aria-label.
 */
export function Icon({
  name,
  filled = false,
  size = 20,
  className = "",
}: {
  name: IconName;
  filled?: boolean;
  size?: 16 | 18 | 20 | 24;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 -960 960 960"
      fill="currentColor"
      className={`shrink-0 ${className}`}
    >
      {TRACK[name] && <path d={ICONS[TRACK[name]].d} opacity="0.3" />}
      <path d={filled ? ICONS[name].fill : ICONS[name].d} />
    </svg>
  );
}
