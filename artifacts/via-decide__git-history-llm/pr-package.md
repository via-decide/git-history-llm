Branch: simba/add-invariant-enforcement-and-runtime-assertions
Title: Add invariant enforcement and runtime assertions to guarantee correct...

## Summary
- Repo orchestration task for via-decide/git-history-llm
- Goal: Add invariant enforcement and runtime assertions to guarantee correctness and detect any internal logic violations immediately.

## Testing Checklist
- [ ] Run unit/integration tests
- [ ] Validate command flow
- [ ] Validate generated artifact files

## Risks
- Prompt quality depends on repository metadata completeness.
- GitHub API limits/token scope can block deep inspection.

## Rollback
- Revert branch and remove generated artifact files if workflow output is invalid.