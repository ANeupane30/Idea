import { ICONS } from "./icons.generated";

export type IconName = keyof typeof ICONS;

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
      <path d={filled ? ICONS[name].fill : ICONS[name].d} />
    </svg>
  );
}
