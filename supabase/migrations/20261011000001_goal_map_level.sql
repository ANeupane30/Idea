-- The level the worker built the topic map for, so the goal page can say
-- "Built for: X" truthfully even after the learner changes their level.
-- Written only by the worker: the goals column grants (title, description,
-- status) do not include it, so authenticated users cannot set it.
alter table public.goals add column map_level text
  check (map_level in ('beginner', 'intermediate', 'advanced'));
