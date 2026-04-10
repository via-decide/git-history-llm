# Architecture

## Overview
Git History LLM is a lightweight, local Python pipeline.

## Directory layout
- `engine/`: git parsing and commit loading
- `analysis/`: reasoning modules for decisions and evolution
- `cli/`: terminal interface and output generation
- `docs/`: architecture, concept, and roadmap docs

## Component responsibilities
1. **GitParser (`engine/git_parser.py`)**
   - Calls `git log` and `git show`.
   - Produces structured commit objects.

2. **CommitLoader (`engine/commit_loader.py`)**
   - Wraps parsed commits into a `CommitBatch`.
   - Provides simple metadata (`total_commits`, `unique_authors`).

3. **DecisionExtractor (`analysis/decision_extractor.py`)**
   - Classifies commit text into heuristic categories.
   - Tracks probable architecture/refactor/feature/fix decisions.

4. **ArchitectureTimelineBuilder (`analysis/architecture_timeline.py`)**
   - Produces architecture-centric timeline entries.
   - Estimates architecture change count.

5. **DeveloperPatternAnalyzer (`analysis/dev_pattern_analyzer.py`)**
   - Models team style from file churn and message patterns.
   - Emits summary profile with bursts and inferred style.

6. **CLI (`cli/git_history_llm.py`)**
   - Exposes `analyze`, `timeline`, `decisions`, and `profile`.
   - Writes markdown and JSON artifacts for developers.

## Data flow
```text
repository path
  -> CommitLoader
  -> DecisionExtractor
  -> ArchitectureTimelineBuilder
  -> DeveloperPatternAnalyzer
  -> Outputs (md/json)
```

## Local-first design constraints
- No external APIs.
- No cloud dependencies.
- Git CLI + Python stdlib only.
- Easy to fork and extend.
