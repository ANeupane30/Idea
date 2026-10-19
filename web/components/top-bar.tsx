import { getViewer } from "@/components/site-header";
import { TopBarView, type TopBarNav } from "@/components/top-bar-view";

/** TopBarView for server pages: loads the user for data-user-id. */
export async function TopBar(props: { back?: TopBarNav; close?: TopBarNav; title: React.ReactNode; actions?: React.ReactNode }) {
  const viewer = await getViewer();
  return <TopBarView userId={viewer.id} {...props} />;
}
