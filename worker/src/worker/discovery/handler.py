"""Shared by the gap phase: which top-level topics no source covers yet, and a goal's subject."""

import re

COVERED = 0.40  # the relevance at which a topic counts as covered (as for lessons)

UNCOVERED_SQL = """
select t.id, t.title from subtopics t
where t.goal_id = %(goal)s and t.parent_id is null
  and not exists (
    select 1 from source_coverage c
    join sources s on s.id = c.source_id and s.status <> 'failed'
    join subtopics x on x.id = c.subtopic_id
    where (x.id = t.id or x.parent_id = t.id) and c.relevance >= %(covered)s)
order by t.position
"""


# As the web's goalTopic: search for the subject, not the learner's phrasing around it.
_LEADING_VERBS = re.compile(r"^(learn the basics of|learn about|learn|how to|understand|master)\s+", re.I)


def goal_topic(goal_title: str) -> str:
    """The subject of a goal: "Learn the basics of personal finance" -> "personal finance"."""
    title = goal_title.strip()
    return _LEADING_VERBS.sub("", title).strip() or title
