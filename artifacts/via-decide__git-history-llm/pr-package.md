Branch: simba/build-knowledge-graph-from-git-history
Title: Build knowledge graph from git history.

## Summary
- Repo orchestration task for via-decide/git-history-llm
- Goal: Build knowledge graph from git history.

## Testing Checklist
- [ ] Run unit/integration tests
- [ ] Validate command flow
- [ ] Validate generated artifact files

## Risks
- Prompt quality depends on repository metadata completeness.
- GitHub API limits/token scope can block deep inspection.

## Rollback
- Revert branch and remove generated artifact files if workflow output is invalid.