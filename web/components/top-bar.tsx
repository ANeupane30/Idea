import Link from "next/link";
import { getViewer } from "@/components/site-header";
import { button } from "@/components/ui/buttons";
import { Icon } from "@/components/ui/icon";

type Nav = { href: string; label: string };

/** The bar of focused pages (lesson, quiz): back or close, the page title, and actions on the right. */
export async function TopBar({
  back,
  close,
  title,
  actions,
}: {
  back?: Nav;
  close?: Nav;
  title: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const viewer = await getViewer();
  const nav = back ?? close;
  return (
    <header
      data-user-id={viewer.id ?? undefined}
      className="flex min-h-16 flex-wrap items-center gap-x-2 gap-y-2 px-2 py-2 sm:px-4"
    >
      {nav && (
        <Link href={nav.href} aria-label={nav.label} className={button("icon", "text-on-surface")}>
          <Icon name={back ? "arrow_back" : "close"} size={24} />
        </Link>
      )}
      <h1 className="min-w-0 flex-1 text-title-l text-on-surface [overflow-wrap:anywhere]">{title}</h1>
      {actions && <div className="flex max-w-full items-center pl-2 max-sm:w-full max-sm:pl-14">{actions}</div>}
    </header>
  );
}
