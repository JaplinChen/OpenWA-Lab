#!/usr/bin/env bash
# Usage: bash scripts/ship.sh "type: commit message"
#
# Ships STAGED changes end-to-end on a solo repo:
#   new branch -> commit -> push -> PR -> squash-merge + delete branch -> main -> pull
#
# Stage what you want first (git add ...); anything unstaged is left untouched.
set -euo pipefail

msg="${1:?usage: bash scripts/ship.sh \"type: commit message\"}"

# Refuse if nothing is staged (protects unrelated working-tree WIP).
if git diff --cached --quiet; then
  echo "Nothing staged. Run 'git add <files>' first." >&2
  exit 1
fi

repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"

# Branch slug from the message: strip "type:", non-alnum -> '-', lowercased, capped.
slug=$(printf '%s' "$msg" \
  | sed -E 's/^[a-z]+(\([^)]*\))?!?: *//' \
  | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' \
  | cut -c1-50)
branch="auto/${slug:-change}"

git checkout -b "$branch"
git commit -m "$msg" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push -u origin "$branch"
gh pr create --repo "$repo" --base main --head "$branch" --title "$msg" --body "$msg"
gh pr merge "$branch" --repo "$repo" --squash --delete-branch
git checkout main
git pull --ff-only origin main

echo "shipped: $msg -> main"
