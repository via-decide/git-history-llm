"""Extract engineering decision signals from commit history."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List

from engine.commit_loader import CommitBatch


DECISION_KEYWORDS = {
    "architecture": ["architecture", "design", "module", "boundary", "layer"],
    "refactor": ["refactor", "cleanup", "simplify", "restructure"],
    "feature": ["feature", "add", "implement", "introduce"],
    "fix": ["fix", "bug", "hotfix", "patch"],
}


@dataclass
class DecisionReport:
    by_category: Dict[str, int]
    top_decisions: List[str]


class DecisionExtractor:
    """Turns commit messages into lightweight decision classifications."""

    def extract(self, commit_batch: CommitBatch) -> DecisionReport:
        counts = {key: 0 for key in DECISION_KEYWORDS}
        matched_messages: List[str] = []

        for commit in commit_batch.commits:
            text = f"{commit.message} {commit.body}".lower()
            for category, keywords in DECISION_KEYWORDS.items():
                if any(keyword in text for keyword in keywords):
                    counts[category] += 1
                    matched_messages.append(f"[{category}] {commit.message}")
                    break

        return DecisionReport(
            by_category=counts,
            top_decisions=matched_messages[:20],
        )
