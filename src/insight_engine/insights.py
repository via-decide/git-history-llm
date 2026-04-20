"""Generate developer-facing repository insights."""

from __future__ import annotations

from collections import Counter, defaultdict

import networkx as nx

from src.git_loader.repo_loader import CommitRecord
from src.history_parser.commit_parser import CommitCategory


class InsightEngine:
    """Creates risk and hotspot insights from commit data and relationship graph."""

    def generate(
        self,
        commits: list[CommitRecord],
        categories: list[CommitCategory],
        graph: nx.DiGraph,
    ) -> dict:
        file_frequency = Counter()
        module_churn = Counter()
        contributor_hotspots: dict[str, set[str]] = defaultdict(set)
        refactor_modules = Counter()

        category_by_commit = {category.commit_id: category.category for category in categories}

        for commit in commits:
            for file_path in commit.files_changed:
                file_frequency[file_path] += 1
                module = self._module_for_file(file_path)
                module_churn[module] += commit.lines_added + commit.lines_removed
                contributor_hotspots[commit.author].add(module)

                if category_by_commit.get(commit.commit_id) == "refactor":
                    refactor_modules[module] += 1

        unstable_modules = [
            {
                "module": module,
                "risk": "high",
                "reason": "frequent changes across multiple commits",
                "churn": churn,
            }
            for module, churn in module_churn.most_common(5)
            if churn >= 300
        ]

        refactor_cycles = [
            {"module": module, "refactor_commits": count}
            for module, count in refactor_modules.most_common(5)
            if count >= 2
        ]

        contributors = [
            {
                "name": author,
                "hotspot_modules": sorted(modules),
                "module_count": len(modules),
            }
            for author, modules in sorted(contributor_hotspots.items(), key=lambda item: len(item[1]), reverse=True)
        ]

        modules = [
            {
                "module": data.get("label", node.replace("module:", "")),
                "commit_frequency": data.get("commit_frequency", 0),
            }
            for node, data in graph.nodes(data=True)
            if data.get("kind") == "module"
        ]

        insights = [
            {
                "type": "most_active_files",
                "data": [{"file": file_path, "commits": count} for file_path, count in file_frequency.most_common(10)],
            },
            {"type": "unstable_modules", "data": unstable_modules},
            {
                "type": "high_churn_code",
                "data": [{"module": module, "churn": churn} for module, churn in module_churn.most_common(10)],
            },
            {"type": "contributor_hotspots", "data": contributors},
            {"type": "refactor_cycles", "data": refactor_cycles},
        ]

        return {
            "insights": insights,
            "contributors": contributors,
            "modules": sorted(modules, key=lambda m: m["commit_frequency"], reverse=True),
        }

    @staticmethod
    def _module_for_file(file_path: str) -> str:
        parts = [part for part in file_path.split("/") if part]
        if len(parts) <= 1:
            return "root"
        return "/".join(parts[:2])
