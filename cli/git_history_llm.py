"""Backward-compatible CLI entrypoint delegating to the new src CLI."""

from src.cli.git_history_cli import main


if __name__ == "__main__":
    main()
