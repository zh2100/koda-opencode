---
description: git commit and push
model: opencode/kimi-k2.5
subtask: true
---

Commit and push the requested changes safely.

Use separate shell commands for commit and push. Do not chain them with `&&`:
the pre-push hook runs the workspace typecheck and may take a while, so keeping
the operations separate makes it clear whether the commit or the push failed.

Before committing:

1. Inspect `git status --short` and the staged diff.
2. Confirm `git config user.name` and `git config user.email` are set. If either
   is missing, stop and ask the user for the values instead of attempting a
   commit.
3. Run `git diff --cached --check`.
4. Commit only the requested, already-staged files. Never stage unrelated
   existing changes.

After the commit succeeds, run `git push origin <current-branch>` as a separate
command and wait for its result. The pre-push hook suppresses routine
typecheck output and prints diagnostics only when the check fails.

make sure it includes a prefix like
docs:
tui:
core:
ci:
ignore:
wip:

For anything in the packages/web use the docs: prefix.

prefer to explain WHY something was done from an end user perspective instead of
WHAT was done.

do not do generic messages like "improved agent experience" be very specific
about what user facing changes were made

if there are conflicts DO NOT FIX THEM. notify me and I will fix them

## GIT DIFF

!`git diff`

## GIT DIFF --cached

!`git diff --cached`

## GIT STATUS --short

!`git status --short`
