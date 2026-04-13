Repair mode for repository via-decide/git-history-llm.

TARGET
Validate and repair only the files touched by the previous implementation.

TASK
Create logical merge conflict predictor.

RULES
1. Audit touched files first and identify regressions.
2. Preserve architecture and naming conventions.
3. Make minimal repairs only; do not expand scope.
4. Re-run checks and provide concise root-cause notes.
5. Return complete contents for changed files only.

SOP: REPAIR PROTOCOL (MANDATORY)
1. Strict Fix Only: Do not use repair mode to expand scope or add features.
2. Regression Check: Audit why previous attempt failed before proposing a fix.
3. Minimal Footprint: Only return contents for the actual repaired files.

REPO CONTEXT
- README snippet:
# Git History LLM **Turn your Git history into engineering intelligence.** A local-first Python system that extracts engineering reasoning from git commit history. > **Understand your codebase history instead of depending on AI autocomplete.** ## 1) Concept Git History LLM analyzes commit stream
- AGENTS snippet:
not found
- package.json snippet:
not found