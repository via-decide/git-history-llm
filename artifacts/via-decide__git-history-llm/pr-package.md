Branch: simba/add-end-to-end-integrity-verification-using-hash
Title: Add end-to-end integrity verification using hash chaining to detect c...

## Summary
- Repo orchestration task for via-decide/git-history-llm
- Goal: Add end-to-end integrity verification using hash chaining to detect corruption and guarantee trust in all processed outputs.

## Testing Checklist
- [ ] Run unit/integration tests
- [ ] Validate command flow
- [ ] Validate generated artifact files

## Risks
- Prompt quality depends on repository metadata completeness.
- GitHub API limits/token scope can block deep inspection.

## Rollback
- Revert branch and remove generated artifact files if workflow output is invalid.