"""Parse Git commit history into structured commit objects."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import subprocess
from typing import List


@dataclass
class Commit:
    """Represents a single commit entry from git history."""

    sha: str
    author: str
    date: str
    message: str
    body: str
    files: List[str]


class GitParser:
    """Low-level Git parser that extracts commits from a repository."""

    def __init__(self, repo_path: str | Path) -> None:
        self.repo_path = Path(repo_path).resolve()

    def parse(self, limit: int | None = None) -> List[Commit]:
        """Parse commit history using `git log` and `git show`.

        Args:
            limit: Optional max number of commits to parse.

        Returns:
            A list of parsed commits, newest first.
        """
        self._assert_repo()
        history = self._get_history(limit=limit)
        commits: List[Commit] = []

        for line in history.splitlines():
            if not line.strip():
                continue
            sha, author, date, message = line.split("\x1f")
            body, files = self._get_commit_details(sha)
            commits.append(
                Commit(
                    sha=sha,
                    author=author,
                    date=date,
                    message=message,
                    body=body,
                    files=files,
                )
            )

        return commits

    def _assert_repo(self) -> None:
        result = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            cwd=self.repo_path,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            raise ValueError(f"Not a git repository: {self.repo_path}")

    def _get_history(self, limit: int | None = None) -> str:
        args = [
            "git",
            "log",
            "--date=iso-strict",
            "--pretty=format:%H%x1f%an%x1f%ad%x1f%s",
        ]
        if limit:
            args.append(f"-{limit}")

        result = subprocess.run(
            args,
            cwd=self.repo_path,
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout

    def _get_commit_details(self, sha: str) -> tuple[str, List[str]]:
        result = subprocess.run(
            ["git", "show", "--quiet", "--pretty=format:%b", sha],
            cwd=self.repo_path,
            capture_output=True,
            text=True,
            check=True,
        )
        body = result.stdout.strip()

        file_result = subprocess.run(
            ["git", "show", "--pretty=format:", "--name-only", sha],
            cwd=self.repo_path,
            capture_output=True,
            text=True,
            check=True,
        )
        files = [line.strip() for line in file_result.stdout.splitlines() if line.strip()]
        return body, files
