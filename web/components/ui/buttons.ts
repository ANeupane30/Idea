export type ButtonVariant = "filled" | "tonal" | "outlined" | "text" | "fab" | "icon";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-full text-label-l transition-colors select-none " +
  "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary " +
  "disabled:pointer-events-none disabled:opacity-50";

const VARIANTS: Record<ButtonVariant, string> = {
  // One filled button per screen: the primary action.
  filled: "min-h-12 px-6 bg-primary text-on-primary hover:bg-primary/90",
  tonal: "min-h-12 px-6 bg-primary-container text-on-primary-container hover:bg-primary-container/80",
  outlined: "min-h-12 px-6 border border-outline text-primary hover:bg-primary/8",
  text: "min-h-12 px-3 text-primary hover:bg-primary/8",
  fab: "min-h-14 px-5 rounded-2xl bg-primary-container text-on-primary-container hover:bg-primary-container/80",
  icon: "size-12 text-on-surface-variant hover:bg-on-surface/8",
};

/** Class string for a Material button. */
export function button(variant: ButtonVariant, extra = ""): string {
  return `${BASE} ${VARIANTS[variant]} ${extra}`.trim();
}

/** Class string for an outlined text field (pill when `pill`). */
export function field(pill = false): string {
  return (
    `w-full border border-outline bg-transparent px-4 text-body-l text-on-surface placeholder:text-on-surface-variant ` +
    `focus:border-2 focus:border-primary focus:outline-none ${pill ? "min-h-14 rounded-full" : "min-h-14 rounded-xl py-3"}`
  );
}
