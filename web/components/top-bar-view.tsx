import Link from "next/link";
import { button } from "@/components/ui/buttons";
import { Icon } from "@/components/ui/icon";

export type TopBarNav = { href: string; label: string };

/** The bar of focused pages (lesson, quiz): back or close, the page title, and actions on the right. */
export function TopBarView({
  userId,
  back,
  close,
  title,
  actions,
}: {
  userId: string | null;
  back?: TopBarNav;
  close?: TopBarNav;
  title: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const nav = back ?? close;
  return (
    <header
      data-user-id={userId ?? undefined}
      className="flex min-h-16 flex-wrap items-center gap-x-2 gap-y-2 px-2 py-2 sm:px-4"
    >
      {nav && (
        <Link href={nav.href} aria-label={nav.label} className={button("icon", "text-on-surface")}>
          <Icon name={back ? "arrow_back" : "close"} size={24} />
        </Link>
      )}
      <h1 className="min-w-0 flex-1 text-title-l text-on-surface [overflow-wrap:anywhere]">{title}</h1>
      {actions && <div className="flex max-w-full items-center max-sm:w-full max-sm:px-2">{actions}</div>}
    </header>
  );
}
