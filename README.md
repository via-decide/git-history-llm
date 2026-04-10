# Git History LLM

**Turn your Git history into engineering intelligence.**

A local-first Python system that extracts engineering reasoning from git commit history.

> **Understand your codebase history instead of depending on AI autocomplete.**

## 1) Concept
Git History LLM analyzes commit streams to infer decision-making patterns, architecture evolution, and team development style. It transforms raw commit metadata into practical reasoning artifacts developers can review, diff, and version.

## 2) Why this exists
- Teams lose context as repositories evolve.
- PR descriptions are often incomplete or inconsistent.
- Cloud-only AI coding tools can obscure provenance and lock teams into proprietary workflows.

This project keeps analysis local, transparent, and forkable.

## 3) How it works
Pipeline:

```text
git repo
  ↓
git_parser
  ↓
commit_loader
  ↓
decision_extractor
  ↓
architecture_timeline
  ↓
developer_pattern_model
```

Core modules:
- `engine/git_parser.py`
- `engine/commit_loader.py`
- `analysis/decision_extractor.py`
- `analysis/architecture_timeline.py`
- `analysis/dev_pattern_analyzer.py`
- `cli/git_history_llm.py`

## 4) Installation
Requirements:
- Python 3.10+
- Git installed and available on PATH

Run locally:

```bash
git clone https://github.com/via-decide/git-history-llm.git
cd git-history-llm
python3 -m cli.git_history_llm --help
```

## 5) Usage
Analyze and generate all outputs:

```bash
python3 -m cli.git_history_llm analyze .
```

Other commands:

```bash
python3 -m cli.git_history_llm timeline <repo>
python3 -m cli.git_history_llm decisions <repo>
python3 -m cli.git_history_llm profile <repo>
```

## 6) Architecture
The system is split into small modules:
- **Engine layer** for Git extraction and normalized commit batches.
- **Analysis layer** for decisions, architecture timeline, and developer behavior heuristics.
- **CLI layer** for command routing and output generation.
- **Docs layer** to keep project intent and extension guidelines clear.

See `docs/ARCHITECTURE.md` for full details.

## 7) Outputs
The `analyze` command produces:
- `repo_architecture.md`
- `decision_history.md`
- `developer_profile.json`
- `system_evolution.md`

## 8) Example results

```json
{
  "architecture_changes": 12,
  "refactors": 31,
  "feature_bursts": 6,
  "dev_style": "modular architecture"
}
```

## 9) Roadmap
See `docs/ROADMAP.md` for near-term milestones, including smarter temporal clustering, richer reasoning classifiers, and optional local visualization support.

## 10) License
MIT — see `LICENSE`.

---

Fork it, run it locally, and adapt it to your own engineering workflows without cloud dependencies.
