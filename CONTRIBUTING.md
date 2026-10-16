# Contributing to Forge

Thanks for helping. The project is moving quickly, so the best contributions are focused, easy to review, and easy to test.

## Branch Model

- **`main`** — where all PRs land. PRs should target `main`.

## Before You Start

- Search existing issues and pull requests before opening a new one.
- Prefer one bug fix or feature per pull request.
- If you want to work on a large feature, open an issue first and describe the approach.
- The four architecture invariants in `CLAUDE.md` are load-bearing — any PR that violates them will be rejected, regardless of how correct the feature otherwise is.

## Setup

```bash
git clone https://github.com/TushaeBXN/anthos-engineer.git
cd anthos-engineer
npm install

# Index the repo
npx tsx cli/index.ts init

# Anthropic (default)
export FORGE_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...

npx tsx cli/index.ts change "add a health check endpoint"
```

Requires: Node.js 22+, npm.

## Running Checks

Run these before opening a PR:

```bash
npx tsc --noEmit      # typecheck
npm test              # 40+ tests across policy, executor, verify, diff suites
```

Mention what you ran in the pull request description. If you could not run a check, say so.

## Architecture Invariants

These hold across every change and are not negotiable:

1. **No code path outside `executor/` may touch `fs` or `shell` for agent-driven changes.** Re-validate the capability token before every operation.
2. **Nothing writes to the materialized graph directly.** Every mutation goes through an event in `events.ts` first.
3. **Normalization happens once.** `policy/evaluator.ts` normalizes an ActionRequest before matching rules. Don't add per-resource normalization outside this path.
4. **Verification is mandatory after every change.** `verify/chain.ts` runs `tsc --noEmit → test → lint` even if an earlier stage fails.

## Pull Requests

Good pull requests include:

- A short explanation of the bug or feature.
- The files or areas changed.
- Test results (`npm test`, `npx tsc --noEmit`).
- Links to related issues: `Fixes #123`.

Keep PRs small. Large PRs that mix unrelated cleanup, refactors, and behavior changes are harder to review.

**Conventional Commits** — PR titles must follow the format:

```
type(scope): summary
```

Examples: `fix(policy): handle wildcard resource match`, `feat(executor): add shell timeout`.
Types: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `revert`.

## Policy Changes

Changes to `forge.policy.yaml` or `policy/` must include:

- An explanation of what the policy change allows or denies.
- The security implications of the change.
- Updated tests in `tests/` that cover the new or changed rules.

## Security

Do not post API keys, tokens, private logs, or personal documents in issues or pull requests.

For security reports, follow [SECURITY.md](SECURITY.md).
