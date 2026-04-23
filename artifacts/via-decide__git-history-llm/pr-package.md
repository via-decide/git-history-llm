Branch: simba/add-time-travel-debugging-and-execution-trace-sn
Title: Add time-travel debugging and execution trace snapshots to enable ful...

## Summary
- Repo orchestration task for via-decide/git-history-llm
- Goal: Add time-travel debugging and execution trace snapshots to enable full forensic analysis and step-by-step replay of pipeline behavior.

## Testing Checklist
- [ ] Run unit/integration tests
- [ ] Validate command flow
- [ ] Validate generated artifact files

## Risks
- Prompt quality depends on repository metadata completeness.
- GitHub API limits/token scope can block deep inspection.

## Rollback
- Revert branch and remove generated artifact files if workflow output is invalid.