"""Developer pattern modeling from commit behavior."""

from __future__ import annotations

from dataclasses import dataclass
from statistics import mean
from typing import Dict, List

from analysis.architecture_timeline import ArchitectureTimeline
from analysis.decision_extractor import DecisionReport
from engine.commit_loader import CommitBatch


@dataclass
class DeveloperProfile:
    architecture_changes: int
    refactors: int
    feature_bursts: int
    dev_style: str
    authors: Dict[str, int]


class DeveloperPatternAnalyzer:
    """Generate high-level reasoning outputs from commit trajectories."""

    def analyze(
        self,
        commit_batch: CommitBatch,
        decisions: DecisionReport,
        timeline: ArchitectureTimeline,
    ) -> DeveloperProfile:
        commits = commit_batch.commits
        by_author: Dict[str, int] = {}
        for commit in commits:
            by_author[commit.author] = by_author.get(commit.author, 0) + 1

        feature_messages = [
            c.message for c in commits if any(token in c.message.lower() for token in ["feature", "add", "implement"])
        ]
        avg_files_changed = mean([len(c.files) for c in commits]) if commits else 0

        if avg_files_changed >= 8:
            style = "large-batch architecture"
        elif timeline.architecture_change_count > decisions.by_category.get("refactor", 0):
            style = "modular architecture"
        else:
            style = "incremental delivery"

        return DeveloperProfile(
            architecture_changes=timeline.architecture_change_count,
            refactors=decisions.by_category.get("refactor", 0),
            feature_bursts=max(1, len(feature_messages) // 5) if feature_messages else 0,
            dev_style=style,
            authors=by_author,
        )
