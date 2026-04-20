"""Commit parsing helpers for category and pattern detection."""

from __future__ import annotations

from dataclasses import dataclass

from src.git_loader.repo_loader import CommitRecord


CATEGORY_PATTERNS = {
    "feature": ["feat:", "feature", "add", "implement"],
    "bugfix": ["fix:", "bug", "hotfix", "patch"],
    "refactor": ["refactor:", "cleanup", "restructure", "rename"],
    "docs": ["docs:", "readme", "documentation", "comment"],
    "infra": ["infra:", "ci", "pipeline", "build", "deploy"],
}


@dataclass
class CommitCategory:
    commit_id: str
    category: str
    matched_pattern: str | None


class CommitParser:
    """Classify commits and detect explicit message patterns."""

    def categorize_commit(self, commit: CommitRecord) -> CommitCategory:
        message = commit.commit_message.lower()

        for category, patterns in CATEGORY_PATTERNS.items():
            for pattern in patterns:
                if pattern in message:
                    return CommitCategory(
                        commit_id=commit.commit_id,
                        category=category,
                        matched_pattern=pattern,
                    )

        return CommitCategory(commit_id=commit.commit_id, category="infra", matched_pattern=None)

    def categorize_commits(self, commits: list[CommitRecord]) -> list[CommitCategory]:
        return [self.categorize_commit(commit) for commit in commits]

    def detect_commit_patterns(self, commits: list[CommitRecord]) -> dict[str, int]:
        """Count common conventional-commit-like prefixes and related patterns."""
        pattern_counts: dict[str, int] = {"fix:": 0, "feat:": 0, "refactor:": 0, "docs:": 0, "infra:": 0}

        for commit in commits:
            message = commit.commit_message.lower()
            for pattern in pattern_counts:
                if pattern in message:
                    pattern_counts[pattern] += 1

        return pattern_counts
