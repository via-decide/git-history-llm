Branch: simba/add-confidence-scoring-and-gating-to-ensure-only
Title: Add confidence scoring and gating to ensure only high-quality, reliab...

## Summary
- Repo orchestration task for via-decide/git-history-llm
- Goal: Add confidence scoring and gating to ensure only high-quality, reliable summaries are accepted and stored.

## Testing Checklist
- [ ] Run unit/integration tests
- [ ] Validate command flow
- [ ] Validate generated artifact files

## Risks
- Prompt quality depends on repository metadata completeness.
- GitHub API limits/token scope can block deep inspection.

## Rollback
- Revert branch and remove generated artifact files if workflow output is invalid.