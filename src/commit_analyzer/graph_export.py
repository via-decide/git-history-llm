"""Export commit relationships as graph JSON for interactive visualization."""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from src.commit_analyzer.change_graph import ChangeGraphBuilder
from src.commit_analyzer.timeline import TimelineBuilder
from src.git_loader.repo_loader import GitRepoLoader
from src.history_parser.commit_parser import CommitParser
from src.insight_engine.insights import InsightEngine


MAX_NODES = 2000


def _serialize_commit(commit) -> dict:
    return {
        "commit_id": commit.commit_id,
        "author": commit.author,
        "timestamp": commit.timestamp,
        "files_changed": commit.files_changed,
        "lines_added": commit.lines_added,
        "lines_removed": commit.lines_removed,
        "commit_message": commit.commit_message,
        "branch": commit.branch,
    }


def _analyze_repository(repo: str | Path) -> dict:
    loader = GitRepoLoader(repo)
    commits = loader.extract_commit_history()

    parser = CommitParser()
    categories = parser.categorize_commits(commits)

    graph = ChangeGraphBuilder().build(commits)
    insights = InsightEngine().generate(commits, categories, graph)
    timeline = TimelineBuilder().build(commits)

    return {
        "repo": str(Path(repo).resolve()),
        "commits": [_serialize_commit(commit) for commit in commits],
        "insights": insights["insights"],
        "contributors": insights["contributors"],
        "modules": insights["modules"],
        "timeline": {
            "commit_frequency": timeline.commit_frequency,
            "major_changes": timeline.major_changes,
            "release_phases": timeline.release_phases,
        },
    }


def _module_for_file(file_path: str) -> str:
    parts = [part for part in file_path.split("/") if part]
    if len(parts) <= 1:
        return "root"
    return "/".join(parts[:2])


def _add_node(nodes: list[dict], node_index: dict[str, dict], node: dict) -> None:
    node_id = node["id"]
    if node_id in node_index:
        return
    node_index[node_id] = node
    nodes.append(node)


def export_graph(repo_path: str | Path, output_dir: str | Path = "output") -> dict:
    """Analyze a repository and export graph + insights JSON artifacts."""
    report = _analyze_repository(repo_path)
    commits = report["commits"]

    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    nodes: list[dict] = []
    edges: list[dict] = []
    node_index: dict[str, dict] = {}

    commits_by_month: dict[str, list[dict]] = defaultdict(list)
    sorted_commits = sorted(commits, key=lambda c: c["timestamp"], reverse=True)

    for commit in sorted_commits:
        month = datetime.fromisoformat(commit["timestamp"]).strftime("%Y-%m")
        commits_by_month[month].append(commit)

    added_commits = 0
    for commit in sorted_commits:
        if len(node_index) >= MAX_NODES:
            break

        commit_node_id = f"commit:{commit['commit_id']}"
        _add_node(
            nodes,
            node_index,
            {
                "id": commit_node_id,
                "type": "commit",
                "hash": commit["commit_id"],
                "author": commit["author"],
                "message": commit["commit_message"],
                "timestamp": commit["timestamp"],
                "files_changed": commit["files_changed"],
            },
        )
        added_commits += 1

        author_node_id = f"author:{commit['author']}"
        _add_node(nodes, node_index, {"id": author_node_id, "type": "author", "name": commit["author"]})
        edges.append({"source": commit_node_id, "target": author_node_id, "type": "authored"})

        for file_name in commit["files_changed"]:
            file_node_id = f"file:{file_name}"
            _add_node(nodes, node_index, {"id": file_node_id, "type": "file", "name": file_name})
            edges.append({"source": commit_node_id, "target": file_node_id, "type": "modified"})

            module_name = _module_for_file(file_name)
            module_node_id = f"module:{module_name}"
            _add_node(nodes, node_index, {"id": module_node_id, "type": "module", "name": module_name})
            edges.append({"source": file_node_id, "target": module_node_id, "type": "dependency"})

    if added_commits < len(sorted_commits):
        included_commit_ids = {n["hash"] for n in nodes if n.get("type") == "commit"}
        for month, month_commits in sorted(commits_by_month.items()):
            remaining = [c for c in month_commits if c["commit_id"] not in included_commit_ids]
            if not remaining:
                continue

            cluster_node_id = f"cluster:{month}"
            _add_node(
                nodes,
                node_index,
                {
                    "id": cluster_node_id,
                    "type": "cluster",
                    "label": f"Older commits {month}",
                    "commit_count": len(remaining),
                },
            )

            month_authors = {commit["author"] for commit in remaining}
            for author in month_authors:
                author_node_id = f"author:{author}"
                _add_node(nodes, node_index, {"id": author_node_id, "type": "author", "name": author})
                edges.append({"source": cluster_node_id, "target": author_node_id, "type": "authored"})

            month_files = {file_name for commit in remaining for file_name in commit["files_changed"]}
            for file_name in month_files:
                file_node_id = f"file:{file_name}"
                _add_node(nodes, node_index, {"id": file_node_id, "type": "file", "name": file_name})
                edges.append({"source": cluster_node_id, "target": file_node_id, "type": "modified"})
                module_name = _module_for_file(file_name)
                module_node_id = f"module:{module_name}"
                _add_node(nodes, node_index, {"id": module_node_id, "type": "module", "name": module_name})
                edges.append({"source": file_node_id, "target": module_node_id, "type": "dependency"})

            if len(node_index) >= MAX_NODES:
                break

    graph_payload = {"nodes": nodes[:MAX_NODES], "edges": edges}
    graph_file = output_path / "graph.json"
    with graph_file.open("w", encoding="utf-8") as fp:
        json.dump(graph_payload, fp, indent=2)

    insights_file = output_path / "insights.json"
    with insights_file.open("w", encoding="utf-8") as fp:
        json.dump(
            {
                "repo": report["repo"],
                "insights": report["insights"],
                "contributors": report["contributors"],
                "modules": report["modules"],
                "timeline": report["timeline"],
            },
            fp,
            indent=2,
        )

    return {
        "graph_path": str(graph_file.resolve()),
        "insights_path": str(insights_file.resolve()),
        "graph": graph_payload,
    }
