"""Repository loading and commit extraction utilities."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterator

from git import Repo


@dataclass
class CommitRecord:
    """Normalized commit payload used by downstream analyzers."""

    commit_id: str
    author: str
    timestamp: str
    files_changed: list[str]
    lines_added: int
    lines_removed: int
    commit_message: str
    branch: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


class GitRepoLoader:
    """Loads commit history and branch metadata from a git repository."""

    def __init__(self, repo_path: str | Path) -> None:
        self.repo_path = Path(repo_path).resolve()
        self.repo = Repo(self.repo_path)

    def track_branch_structure(self) -> dict[str, str]:
        """Return branch heads as {branch_name: commit_id}."""
        return {branch.name: branch.commit.hexsha for branch in self.repo.branches}

    def stream_commits(self, limit: int | None = None, rev: str = "HEAD") -> Iterator[CommitRecord]:
        """Yield commits without loading entire repository history into memory."""
        count = 0
        for commit in self.repo.iter_commits(rev=rev):
            if limit is not None and count >= limit:
                break

            stats = commit.stats.total
            files_changed = sorted(commit.stats.files.keys())

            yield CommitRecord(
                commit_id=commit.hexsha,
                author=commit.author.name,
                timestamp=datetime.fromtimestamp(commit.committed_date).isoformat(),
                files_changed=files_changed,
                lines_added=int(stats.get("insertions", 0)),
                lines_removed=int(stats.get("deletions", 0)),
                commit_message=commit.message.strip(),
                branch=self._infer_branch_for_commit(commit.hexsha),
            )
            count += 1

    def extract_commit_history(self, limit: int | None = None, rev: str = "HEAD") -> list[CommitRecord]:
        """Collect commits into a list for workflows that need full history snapshots."""
        return list(self.stream_commits(limit=limit, rev=rev))

    def _infer_branch_for_commit(self, commit_id: str) -> str | None:
        """Best effort branch association for a commit."""
        for branch in self.repo.branches:
            if commit_id in self.repo.git.branch("--contains", commit_id, branch.name):
                return branch.name
        return None
