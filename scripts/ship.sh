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
owner="${repo%%/*}"  # qualify the head ref so a fork PR targets this repo, not its upstream parent

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
# Retry PR creation: after a push, GitHub can take ~10s to make the new branch
# resolvable to the PR API ("No commits between..." / "Head sha can't be blank").
for attempt in $(seq 1 6); do
  gh pr create --repo "$repo" --base main --head "$owner:$branch" --title "$msg" --body "$msg" && break
  [ "$attempt" -eq 6 ] && { echo "PR create failed after 6 attempts (~18s)" >&2; exit 1; }
  echo "PR create not ready (attempt $attempt) — retrying in 3s..." >&2
  sleep 3
done
gh pr merge "$branch" --repo "$repo" --squash --delete-branch
git checkout main
git pull --ff-only origin main

echo "shipped: $msg -> main"
