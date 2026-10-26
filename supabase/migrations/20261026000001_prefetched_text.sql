-- A found page's text as the search returned it, so it's read without fetching (worker only:
-- not in the column grants, so learners can't set it).
alter table public.sources add column prefetched text;
