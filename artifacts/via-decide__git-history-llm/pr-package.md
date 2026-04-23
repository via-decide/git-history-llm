Branch: simba/enforce-deterministic-llm-output-by-adding-input
Title: Enforce deterministic LLM output by adding input normalization, outpu...

## Summary
- Repo orchestration task for via-decide/git-history-llm
- Goal: Enforce deterministic LLM output by adding input normalization, output canonicalization, and double-run consistency verification.

## Testing Checklist
- [ ] Run unit/integration tests
- [ ] Validate command flow
- [ ] Validate generated artifact files

## Risks
- Prompt quality depends on repository metadata completeness.
- GitHub API limits/token scope can block deep inspection.

## Rollback
- Revert branch and remove generated artifact files if workflow output is invalid.