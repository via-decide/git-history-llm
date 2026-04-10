"""Load and normalize parsed commits for downstream analysis."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import List

from engine.git_parser import Commit, GitParser


@dataclass
class CommitBatch:
    """Container for commit collections and simple metadata."""

    repo_path: Path
    commits: List[Commit]

    @property
    def total_commits(self) -> int:
        return len(self.commits)

    @property
    def unique_authors(self) -> int:
        return len({c.author for c in self.commits})


class CommitLoader:
    """Builds higher-level commit batches from raw Git history."""

    def __init__(self, repo_path: str | Path) -> None:
        self.repo_path = Path(repo_path).resolve()
        self.parser = GitParser(self.repo_path)

    def load(self, limit: int | None = None) -> CommitBatch:
        commits = self.parser.parse(limit=limit)
        return CommitBatch(repo_path=self.repo_path, commits=commits)
