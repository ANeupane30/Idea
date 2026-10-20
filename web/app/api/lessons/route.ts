import { createClient } from "@/lib/supabase/server";
import { lessonRequestSchema } from "@/lib/lessons";

/**
 * Starts or fetches a lesson: checks that the signed-in user (guests included) can see the
 * topic, then relays the lesson server's NDJSON stream to the browser.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = lessonRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400 });

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return Response.json({ error: "unauthorized" }, { status: 401 });

  // RLS: only the owner's subtopics are visible.
  const { data: topic } = await supabase
    .from("subtopics")
    .select("id")
    .eq("id", parsed.data.subtopicId)
    .maybeSingle();
  if (!topic) return Response.json({ error: "not_found" }, { status: 404 });

  const url = process.env.LESSON_SERVER_URL;
  const token = process.env.LESSON_SERVER_TOKEN;
  if (!url || !token) return Response.json({ error: "unavailable" }, { status: 503 });

  let upstream: Response;
  try {
    upstream = await fetch(`${url}/lessons`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        user_id: auth.user.id,
        subtopic_id: parsed.data.subtopicId,
        format: parsed.data.format,
        refresh: parsed.data.refresh ?? false,
      }),
      cache: "no-store",
      signal: request.signal,
    });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
  if (!upstream.ok || !upstream.body) return Response.json({ error: "unavailable" }, { status: 503 });

  return new Response(upstream.body, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}
