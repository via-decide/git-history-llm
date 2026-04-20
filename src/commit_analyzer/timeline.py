"""Timeline generation for commit activity and release phases."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import datetime

from src.git_loader.repo_loader import CommitRecord


@dataclass
class TimelineReport:
    commit_frequency: dict[str, int]
    major_changes: list[dict]
    release_phases: list[dict]


class TimelineBuilder:
    """Build timeline-oriented views over commit history."""

    def build(self, commits: list[CommitRecord]) -> TimelineReport:
        by_day = Counter()
        major_changes: list[dict] = []
        release_phases: list[dict] = []

        for commit in commits:
            day = datetime.fromisoformat(commit.timestamp).date().isoformat()
            by_day[day] += 1

            churn = commit.lines_added + commit.lines_removed
            if churn >= 200 or len(commit.files_changed) >= 10:
                major_changes.append(
                    {
                        "commit_id": commit.commit_id,
                        "timestamp": commit.timestamp,
                        "message": commit.commit_message,
                        "files_changed": len(commit.files_changed),
                        "churn": churn,
                    }
                )

            msg = commit.commit_message.lower()
            if any(token in msg for token in ["release", "version", "rc", "milestone"]):
                release_phases.append(
                    {
                        "commit_id": commit.commit_id,
                        "timestamp": commit.timestamp,
                        "phase": commit.commit_message,
                    }
                )

        return TimelineReport(
            commit_frequency=dict(sorted(by_day.items())),
            major_changes=major_changes,
            release_phases=release_phases,
        )
