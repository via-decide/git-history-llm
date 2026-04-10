"""CLI entrypoint for Git History LLM."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from analysis.architecture_timeline import ArchitectureTimelineBuilder
from analysis.decision_extractor import DecisionExtractor
from analysis.dev_pattern_analyzer import DeveloperPatternAnalyzer
from engine.commit_loader import CommitLoader


def run_pipeline(repo: str | Path, limit: int | None = None):
    loader = CommitLoader(repo)
    batch = loader.load(limit=limit)

    extractor = DecisionExtractor()
    decisions = extractor.extract(batch)

    timeline_builder = ArchitectureTimelineBuilder()
    timeline = timeline_builder.build(batch, decisions)

    pattern_analyzer = DeveloperPatternAnalyzer()
    profile = pattern_analyzer.analyze(batch, decisions, timeline)

    return batch, decisions, timeline, profile


def write_outputs(repo: str | Path, decisions, timeline, profile) -> None:
    output_dir = Path(repo)

    (output_dir / "decision_history.md").write_text(
        "# Decision History\n\n"
        + "\n".join(f"- {line}" for line in decisions.top_decisions)
        + "\n",
        encoding="utf-8",
    )

    (output_dir / "repo_architecture.md").write_text(
        "# Repository Architecture Timeline\n\n"
        + "\n".join(f"- {entry.date} `{entry.sha}`: {entry.summary}" for entry in timeline.entries)
        + "\n",
        encoding="utf-8",
    )

    (output_dir / "system_evolution.md").write_text(
        "# System Evolution\n\n"
        f"- Architecture changes: {profile.architecture_changes}\n"
        f"- Refactors: {profile.refactors}\n"
        f"- Feature bursts: {profile.feature_bursts}\n"
        f"- Inferred style: {profile.dev_style}\n",
        encoding="utf-8",
    )

    (output_dir / "developer_profile.json").write_text(
        json.dumps(
            {
                "architecture_changes": profile.architecture_changes,
                "refactors": profile.refactors,
                "feature_bursts": profile.feature_bursts,
                "dev_style": profile.dev_style,
                "authors": profile.authors,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="git-history-llm", description="Analyze git history with local reasoning modules")
    sub = parser.add_subparsers(dest="command", required=True)

    for command in ["analyze", "timeline", "decisions", "profile"]:
        cmd = sub.add_parser(command)
        cmd.add_argument("repo", help="Path to git repository")
        cmd.add_argument("--limit", type=int, default=None, help="Optional commit limit")

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    _, decisions, timeline, profile = run_pipeline(args.repo, limit=args.limit)

    if args.command == "analyze":
        write_outputs(args.repo, decisions, timeline, profile)
        print(
            json.dumps(
                {
                    "architecture_changes": profile.architecture_changes,
                    "refactors": profile.refactors,
                    "feature_bursts": profile.feature_bursts,
                    "dev_style": profile.dev_style,
                },
                indent=2,
            )
        )
    elif args.command == "timeline":
        for entry in timeline.entries:
            print(f"{entry.date} {entry.sha} {entry.summary}")
    elif args.command == "decisions":
        print(json.dumps(decisions.by_category, indent=2))
    elif args.command == "profile":
        print(
            json.dumps(
                {
                    "architecture_changes": profile.architecture_changes,
                    "refactors": profile.refactors,
                    "feature_bursts": profile.feature_bursts,
                    "dev_style": profile.dev_style,
                    "authors": profile.authors,
                },
                indent=2,
            )
        )


if __name__ == "__main__":
    main()
