import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { MAP_STATUS_TEXT } from "@/lib/validation";

// Minimal placeholder; Task 8 replaces it.
async function Goal({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const { data } = await supabase.from("goals").select("title, map_status").eq("id", id).maybeSingle();
  if (!data) notFound();
  return (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold">{data.title}</h1>
      <p className="mt-2 text-sm text-zinc-600">{MAP_STATUS_TEXT[data.map_status as string] ?? ""}</p>
    </main>
  );
}

export default function GoalPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="p-6">Loading...</p>}>
      <Goal params={params} />
    </Suspense>
  );
}
