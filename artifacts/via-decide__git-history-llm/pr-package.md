Branch: simba/add-multi-level-fallback-and-degraded-execution-
Title: Add multi-level fallback and degraded execution mode to ensure the sy...

## Summary
- Repo orchestration task for via-decide/git-history-llm
- Goal: Add multi-level fallback and degraded execution mode to ensure the system produces usable summaries even when LLM fails.

## Testing Checklist
- [ ] Run unit/integration tests
- [ ] Validate command flow
- [ ] Validate generated artifact files

## Risks
- Prompt quality depends on repository metadata completeness.
- GitHub API limits/token scope can block deep inspection.

## Rollback
- Revert branch and remove generated artifact files if workflow output is invalid.