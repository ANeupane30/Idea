"use client";

import { Icon, type IconName } from "@/components/ui/icon";
import { FORMAT_TEXT, FORMATS, type Format } from "@/lib/lessons";

const FORMAT_ICON: Record<Format, IconName> = {
  visual: "schema",
  text: "notes",
  examples: "lightbulb",
  summary: "format_list_bulleted",
};

/**
 * The four lesson formats as selectable cards. Each card's radio is laid invisibly over it, so the
 * radio takes the clicks itself; its name is "<Label> <hint>". Controlled with `value`/`onChange`,
 * or uncontrolled with `defaultValue` inside a form.
 */
export function FormatCards({
  name,
  labelledBy,
  value,
  defaultValue,
  onChange,
}: {
  name: string;
  labelledBy?: string;
  value?: Format;
  defaultValue?: Format;
  onChange?: (f: Format) => void;
}) {
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="grid gap-3 sm:grid-cols-2">
      {FORMATS.map((f) => (
        <label
          key={f}
          className="group relative flex cursor-pointer flex-col gap-1 rounded-2xl border border-outline-variant bg-surface p-4 text-on-surface transition-colors hover:bg-on-surface/4 has-checked:border-2 has-checked:border-primary has-checked:bg-primary-container has-checked:p-[15px] has-checked:text-on-primary-container has-focus-visible:outline-3 has-focus-visible:outline-offset-2 has-focus-visible:outline-primary"
        >
          <input
            type="radio"
            name={name}
            value={f}
            required
            {...(value !== undefined ? { checked: value === f } : { defaultChecked: defaultValue === f })}
            onChange={() => onChange?.(f)}
            aria-label={`${FORMAT_TEXT[f].label} ${FORMAT_TEXT[f].hint}`}
            className="peer absolute inset-0 z-10 m-0 cursor-pointer appearance-none opacity-0"
          />
          <Icon name={FORMAT_ICON[f]} size={24} className="text-primary" />
          <Icon
            name="check_circle"
            filled
            size={24}
            className="absolute top-3 right-3 hidden text-primary peer-checked:block"
          />
          <span className="mt-2 text-title-m">{FORMAT_TEXT[f].label}</span>
          <span className="text-body-m text-on-surface-variant group-has-checked:text-on-primary-container">
            {FORMAT_TEXT[f].hint}
          </span>
        </label>
      ))}
    </div>
  );
}
