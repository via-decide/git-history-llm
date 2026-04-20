"""Command line interface for repository history reasoning."""

from __future__ import annotations

import argparse
import json
import webbrowser
from pathlib import Path

from src.commit_analyzer.change_graph import ChangeGraphBuilder
from src.commit_analyzer.graph_export import export_graph
from src.commit_analyzer.timeline import TimelineBuilder
from src.git_loader.repo_loader import GitRepoLoader
from src.history_parser.commit_parser import CommitParser
from src.insight_engine.insights import InsightEngine


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


def analyze_repository(repo: str | Path, limit: int | None = None) -> dict:
    loader = GitRepoLoader(repo)
    commits = loader.extract_commit_history(limit=limit)

    parser = CommitParser()
    categories = parser.categorize_commits(commits)
    patterns = parser.detect_commit_patterns(commits)

    graph = ChangeGraphBuilder().build(commits)
    insights = InsightEngine().generate(commits, categories, graph)
    timeline = TimelineBuilder().build(commits)

    return {
        "repo": str(Path(repo).resolve()),
        "branch_structure": loader.track_branch_structure(),
        "patterns": patterns,
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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="git-history", description="Repository history reasoning CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    for command in ["analyze", "insights", "timeline", "contributors"]:
        cmd = sub.add_parser(command)
        cmd.add_argument("repo", help="Path to git repository")
        cmd.add_argument("--limit", type=int, default=None, help="Optional commit limit")
        cmd.add_argument("--json", action="store_true", help="Emit machine-readable JSON output")

    graph_cmd = sub.add_parser("graph")
    graph_cmd.add_argument("repo", help="Path to git repository")
    graph_cmd.add_argument("--output-dir", default="output", help="Where graph.json and insights.json are written")
    graph_cmd.add_argument(
        "--ui-path",
        default="ui/index.html",
        help="Path to graph UI entrypoint (opened after graph export)",
    )
    graph_cmd.add_argument("--json", action="store_true", help="Emit machine-readable JSON output")

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "graph":
        export_result = export_graph(args.repo, output_dir=args.output_dir)
        ui_file = Path(args.ui_path).resolve()
        ui_url = ui_file.as_uri()
        webbrowser.open(ui_url)

        payload = {
            "repo": str(Path(args.repo).resolve()),
            "graph_path": export_result["graph_path"],
            "insights_path": export_result["insights_path"],
            "ui": ui_url,
        }
        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            print(json.dumps(payload, indent=2))
        return

    report = analyze_repository(args.repo, limit=args.limit)

    if args.command == "analyze":
        payload = {
            "repo": report["repo"],
            "commits": report["commits"],
            "insights": report["insights"],
            "contributors": report["contributors"],
            "modules": report["modules"],
        }
    elif args.command == "insights":
        payload = {"repo": report["repo"], "insights": report["insights"], "patterns": report["patterns"]}
    elif args.command == "timeline":
        payload = {"repo": report["repo"], "timeline": report["timeline"]}
    else:
        payload = {"repo": report["repo"], "contributors": report["contributors"]}

    if args.json:
        print(json.dumps(payload, indent=2))
        return

    if args.command == "timeline":
        for day, count in payload["timeline"]["commit_frequency"].items():
            print(f"{day}: {count} commits")
    elif args.command == "contributors":
        for contributor in payload["contributors"]:
            print(f"{contributor['name']}: {contributor['module_count']} module hotspots")
    else:
        print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
