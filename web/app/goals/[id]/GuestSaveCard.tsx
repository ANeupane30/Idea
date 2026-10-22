"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { button } from "@/components/ui/buttons";
import { Icon } from "@/components/ui/icon";

const KEY = "guest-save-dismissed";

/** Guests only: a dismissible nudge to create an account. Dismissal is remembered in this browser. */
export function GuestSaveCard() {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      // Restoring a remembered choice after hydration (the server can't know it).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (localStorage.getItem(KEY) === "1") setDismissed(true);
    } catch {
      // Storage blocked: the card just shows again.
    }
  }, []);

  if (dismissed) return null;
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-outline-variant p-4 text-body-m text-on-surface">
      <Icon name="cloud_upload" size={24} className="mt-0.5 text-on-surface-variant" />
      <p className="flex-1">
        Save your progress.{" "}
        <Link href="/sign-up" className="text-primary underline underline-offset-2">
          Create a free account.
        </Link>
      </p>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => {
          setDismissed(true);
          try {
            localStorage.setItem(KEY, "1");
          } catch {
            // Not remembered; fine.
          }
        }}
        className={button("icon", "-my-3 -mr-3")}
      >
        <Icon name="close" size={20} />
      </button>
    </div>
  );
}
