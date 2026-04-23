Branch: simba/add-graceful-shutdown-and-signal-handling-to-ens
Title: Add graceful shutdown and signal handling to ensure safe termination ...

## Summary
- Repo orchestration task for via-decide/git-history-llm
- Goal: Add graceful shutdown and signal handling to ensure safe termination without data loss or system corruption.

## Testing Checklist
- [ ] Run unit/integration tests
- [ ] Validate command flow
- [ ] Validate generated artifact files

## Risks
- Prompt quality depends on repository metadata completeness.
- GitHub API limits/token scope can block deep inspection.

## Rollback
- Revert branch and remove generated artifact files if workflow output is invalid.