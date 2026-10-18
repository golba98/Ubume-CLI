# Project: Ubume CLI PR #310 Clean Replacement & Verification

## Architecture
- **Repository**: `https://github.com/golba98/Ubume.git`
- **Base Branch**: `origin/main` (`7063419f60030c962b0e0b732ba04f9b467a49b6`)
- **Original Refactor Branch**: `refactor/codebase-quality-2026-10-18` (10 linear commits ahead of `origin/main`)
- **Clean Replacement Branch**: `refactor/codebase-quality-v2`
- **PR #310**: Target for closure with comment: `"Closing in favor of a clean PR without single-agent co-author attribution."`
- **Replacement PR**: Target from `refactor/codebase-quality-v2` into `main` with full technical summary and 0 Claude attribution.
- **Verification Invariant**: Tree hash at HEAD must remain `0ab8cb1f1da48e7c671f56f1c349c9fb566a2403`. Tree diff against `origin/main` must be identical to PR #310 diff.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Close PR #310 | Close PR #310 via `gh pr close 310 --comment "Closing in favor of a clean PR without single-agent co-author attribution."` | M1 | ORIGINAL_REQUEST §R1 |
| 2 | Rewrite Git History | Strip all `Co-Authored-By: Claude <noreply@anthropic.com>` trailers from 10 commits; retain author `golba98 <jordanvorster404@gmail.com>` | M1 | ORIGINAL_REQUEST §R2 |
| 3 | Create & Push v2 Branch | Create `refactor/codebase-quality-v2` with rewritten commits and push to `origin` | M1 | ORIGINAL_REQUEST §R3 |
| 4 | Open Replacement PR | Open PR from `refactor/codebase-quality-v2` to `main` with full technical body from PR #310 without Claude attribution | M1 | ORIGINAL_REQUEST §R3 |
| 5 | Subsystem Verification | Run and pass `bun run typecheck`, `bun run check`, `bun test` with 0 errors | M1 | ORIGINAL_REQUEST §R4 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Clean PR Replacement & Subsystem Verification | Close PR #310, rewrite 10 commits on `refactor/codebase-quality-v2`, push branch, open replacement PR, verify verification suite (`bun run typecheck`, `bun run check`, `bun test`) | none | IN_PROGRESS |

## Interface Contracts & Invariants
- **PR State Contract**:
  - `gh pr view 310 --json state` must return `"state": "CLOSED"`.
  - `gh pr view <new-pr-number> --json state,headRefName,baseRefName` must return `"OPEN"`, `"refactor/codebase-quality-v2"`, and `"main"`.
- **Git Attribution Contract**:
  - `git log origin/main..refactor/codebase-quality-v2 --grep="Claude" --grep="noreply@anthropic.com"` returns 0 results.
  - `git log origin/main..refactor/codebase-quality-v2 --format="%an <%ae>"` returns only `golba98 <jordanvorster404@gmail.com>`.
  - `git rev-parse refactor/codebase-quality-v2^{tree}` equals `0ab8cb1f1da48e7c671f56f1c349c9fb566a2403`.
- **Subsystem Verification Contract**:
  - `bun run typecheck`: exit 0
  - `bun run check`: exit 0 (510 files checked, 0 issues)
  - `bun test`: exit 0 (2454 pass, 0 fail across 227 files)
  - Critical Invariant: Do NOT run `bun run build` during or after rewrite because `scripts/gen-build-info.mjs` overwrites `src/config/buildInfo.ts` with the new commit hash.

## Code Layout
- Exclusive write ownership for Worker:
  - Git repository branches and references (`refs/heads/refactor/codebase-quality-v2`, `origin/refactor/codebase-quality-v2`)
  - GitHub PR state (close #310, create replacement PR)
  - `.agents/teamwork/worker_1/`
- Working tree files must NOT be mutated or dirtied.
