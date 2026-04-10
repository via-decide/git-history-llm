"""Build architecture timeline and evolution summaries from commit decisions."""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

from analysis.decision_extractor import DecisionReport
from engine.commit_loader import CommitBatch


@dataclass
class TimelineEntry:
    date: str
    sha: str
    summary: str


@dataclass
class ArchitectureTimeline:
    entries: List[TimelineEntry]
    architecture_change_count: int


class ArchitectureTimelineBuilder:
    """Creates architecture-centric timeline signals from commits."""

    def build(self, commit_batch: CommitBatch, decisions: DecisionReport) -> ArchitectureTimeline:
        entries: List[TimelineEntry] = []

        for commit in commit_batch.commits:
            message_lower = commit.message.lower()
            if any(token in message_lower for token in ["arch", "module", "layer", "refactor", "structure"]):
                entries.append(
                    TimelineEntry(
                        date=commit.date,
                        sha=commit.sha[:8],
                        summary=commit.message,
                    )
                )

        return ArchitectureTimeline(
            entries=entries,
            architecture_change_count=decisions.by_category.get("architecture", 0),
        )
