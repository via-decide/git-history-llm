Branch: simba/add-versioned-execution-contracts-and-compatibil
Title: Add versioned execution contracts and compatibility enforcement to pr...

## Summary
- Repo orchestration task for via-decide/git-history-llm
- Goal: Add versioned execution contracts and compatibility enforcement to prevent breaking changes and ensure safe system evolution.

## Testing Checklist
- [ ] Run unit/integration tests
- [ ] Validate command flow
- [ ] Validate generated artifact files

## Risks
- Prompt quality depends on repository metadata completeness.
- GitHub API limits/token scope can block deep inspection.

## Rollback
- Revert branch and remove generated artifact files if workflow output is invalid.