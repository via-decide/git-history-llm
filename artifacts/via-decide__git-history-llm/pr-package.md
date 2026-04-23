Branch: simba/add-rate-limiting-and-token-budget-enforcement-t
Title: Add rate limiting and token budget enforcement to control LLM usage, ...

## Summary
- Repo orchestration task for via-decide/git-history-llm
- Goal: Add rate limiting and token budget enforcement to control LLM usage, prevent cost overruns, and stabilize processing under scale.

## Testing Checklist
- [ ] Run unit/integration tests
- [ ] Validate command flow
- [ ] Validate generated artifact files

## Risks
- Prompt quality depends on repository metadata completeness.
- GitHub API limits/token scope can block deep inspection.

## Rollback
- Revert branch and remove generated artifact files if workflow output is invalid.