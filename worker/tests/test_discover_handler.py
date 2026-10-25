"""goal_topic, kept from the after-ready discovery (replaced by the gap phase, test_gaps.py)."""


def test_goal_topic_strips_learning_phrases():
    from worker.discovery.handler import goal_topic

    assert goal_topic("Learn the basics of personal finance") == "personal finance"
    assert goal_topic("Learn about Roman history") == "Roman history"
    assert goal_topic("learn SQL") == "SQL"
    assert goal_topic("How to bake bread") == "bake bread"
    assert goal_topic("Understand statistics") == "statistics"
    assert goal_topic("Master chess openings") == "chess openings"
    assert goal_topic("SQL") == "SQL"

