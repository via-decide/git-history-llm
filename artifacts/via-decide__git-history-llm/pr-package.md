Branch: simba/add-centralized-configuration-validation-and-run
Title: Add centralized configuration validation and runtime guardrails to pr...

## Summary
- Repo orchestration task for via-decide/git-history-llm
- Goal: Add centralized configuration validation and runtime guardrails to prevent invalid system states and misconfiguration failures.

## Testing Checklist
- [ ] Run unit/integration tests
- [ ] Validate command flow
- [ ] Validate generated artifact files

## Risks
- Prompt quality depends on repository metadata completeness.
- GitHub API limits/token scope can block deep inspection.

## Rollback
- Revert branch and remove generated artifact files if workflow output is invalid.