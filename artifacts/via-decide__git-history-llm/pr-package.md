Branch: simba/convert-git-history-llm-from-manual-prompt-based
Title: Convert git-history-llm from manual prompt-based summarization into a...

## Summary
- Repo orchestration task for via-decide/git-history-llm
- Goal: Convert git-history-llm from manual prompt-based summarization into a deterministic, automated commit intelligence pipeline.

## Testing Checklist
- [ ] Run unit/integration tests
- [ ] Validate command flow
- [ ] Validate generated artifact files

## Risks
- Prompt quality depends on repository metadata completeness.
- GitHub API limits/token scope can block deep inspection.

## Rollback
- Revert branch and remove generated artifact files if workflow output is invalid.