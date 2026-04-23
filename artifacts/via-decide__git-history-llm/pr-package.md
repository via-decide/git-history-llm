Branch: simba/add-checkpointing-and-resumable-execution-to-ens
Title: Add checkpointing and resumable execution to ensure zero progress los...

## Summary
- Repo orchestration task for via-decide/git-history-llm
- Goal: Add checkpointing and resumable execution to ensure zero progress loss and reliable recovery from interruptions or crashes.

## Testing Checklist
- [ ] Run unit/integration tests
- [ ] Validate command flow
- [ ] Validate generated artifact files

## Risks
- Prompt quality depends on repository metadata completeness.
- GitHub API limits/token scope can block deep inspection.

## Rollback
- Revert branch and remove generated artifact files if workflow output is invalid.