Branch: simba/create-commit-frequency-analyzer
Title: Create commit frequency analyzer.

## Summary
- Repo orchestration task for via-decide/git-history-llm
- Goal: Create commit frequency analyzer.

## Testing Checklist
- [ ] Run unit/integration tests
- [ ] Validate command flow
- [ ] Validate generated artifact files

## Risks
- Prompt quality depends on repository metadata completeness.
- GitHub API limits/token scope can block deep inspection.

## Rollback
- Revert branch and remove generated artifact files if workflow output is invalid.