Branch: simba/create-module-history-onboarding-assistant
Title: Create module history onboarding assistant.

## Summary
- Repo orchestration task for via-decide/git-history-llm
- Goal: Create module history onboarding assistant.

## Testing Checklist
- [ ] Run unit/integration tests
- [ ] Validate command flow
- [ ] Validate generated artifact files

## Risks
- Prompt quality depends on repository metadata completeness.
- GitHub API limits/token scope can block deep inspection.

## Rollback
- Revert branch and remove generated artifact files if workflow output is invalid.