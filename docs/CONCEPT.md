# Concept

Git History LLM treats commit history as an engineering reasoning trail.

Instead of asking a cloud assistant to infer context from incomplete prompts, this project mines your repository history directly and locally:

- What changed?
- Why might it have changed?
- How did architecture decisions evolve over time?
- What delivery patterns do maintainers follow?

## Core idea
Commits are not just diffs. They are decision artifacts. By layering lightweight analysis modules over git history, teams can extract practical intelligence from work they already did.

## Philosophy
- Local-first over cloud-first.
- Transparent heuristics over opaque black-box inference.
- Forkable tooling over proprietary dependency.

## Who this is for
- Maintainers onboarding to legacy codebases
- Teams preparing design reviews or postmortems
- Developers who want historical context before coding

## Message
**Understand your codebase history instead of depending on AI autocomplete.**
