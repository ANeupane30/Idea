"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/components/ui/icon";

type Item = { label: string; href: string; icon: IconName; active: boolean };

/**
 * Goals and (inside a goal) Review. A rail on the left from `sm`, a bottom bar below it.
 * Account actions sit at the end.
 */
export function NavRail({ goalId, account }: { goalId?: string; account: React.ReactNode }) {
  const path = usePathname();
  const inReview = /^\/goals\/[^/]+\/review(\/|$)/.test(path);
  const items: Item[] = [{ label: "Goals", href: "/goals", icon: "flag", active: !inReview }];
  if (goalId) {
    items.push({ label: "Review", href: `/goals/${goalId}/review`, icon: "event_repeat", active: inReview });
  }
  return (
    <nav
      aria-label="Main"
      className="flex h-full items-start justify-around gap-2 px-2 py-3 sm:flex-col sm:items-center sm:justify-between sm:px-0 sm:py-6"
    >
      <ul className="flex gap-2 sm:flex-col sm:gap-3">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={item.active ? "page" : undefined}
              className="group flex w-16 flex-col items-center gap-1 rounded-2xl py-1 text-label-m text-on-surface-variant aria-[current=page]:text-on-surface focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <span className="grid h-8 w-14 place-items-center rounded-full transition-colors group-hover:bg-on-surface/8 group-aria-[current=page]:bg-secondary-container group-aria-[current=page]:text-on-secondary-container">
                <Icon name={item.icon} size={24} filled={item.active} />
              </span>
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
      <div className="flex gap-2 sm:flex-col sm:items-center sm:gap-3">{account}</div>
    </nav>
  );
}
