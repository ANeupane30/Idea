-- The topic map is designed by the AI worker only. Users can read their own
-- subtopics (RLS) but never create, rename, move, nest or delete them.
-- The depth and trim triggers still apply to worker writes.
revoke insert, update, delete on public.subtopics from authenticated;

drop function public.move_subtopic(uuid, uuid, int);
