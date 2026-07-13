#!/usr/bin/env bash
# PreToolUse hook (matcher: Bash) that blocks destructive git commands when
# they could discard local work — uncommitted changes or commits that exist
# on a local branch but on no remote.
#
# Exit codes: 0 = allow, 2 = block (stderr is fed back to the agent).
# Fails open on parse errors so a broken hook never bricks the session.
set -uo pipefail

input=$(cat)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
if [ -z "$cmd" ] && command -v python3 >/dev/null 2>&1; then
  cmd=$(printf '%s' "$input" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null)
fi
[ -z "$cmd" ] && exit 0

case "$cmd" in
  *git*) ;;
  *) exit 0 ;;
esac

deny() {
  {
    echo "BLOCKED by .claude/hooks/git-safety.sh: $1"
    echo "Protect local work before discarding anything:"
    echo "  - commit or stash uncommitted changes"
    echo "  - push unpushed commits, or save them: git branch backup/\$(date +%Y%m%d-%H%M%S)"
    echo "If the user has explicitly confirmed the work should be discarded, back it up to a branch first, then proceed."
  } >&2
  exit 2
}

# --- Always blocked, regardless of repo state -------------------------------

# Plain force push can destroy remote history; --force-with-lease is allowed.
if printf '%s' "$cmd" | grep -Eq 'git\b[^|;&]*\bpush\b[^|;&]*(\s--force(\s|$|[;&|])|\s-[a-zA-Z]*f\b)'; then
  if ! printf '%s' "$cmd" | grep -q -- '--force-with-lease'; then
    deny "plain force push ('git push --force' / '-f'). Use --force-with-lease instead."
  fi
fi

# Dropping stashes destroys work that no status check can see.
if printf '%s' "$cmd" | grep -Eq 'git\b[^|;&]*\bstash\b[^|;&]*\b(drop|clear)\b'; then
  deny "'git stash drop/clear' permanently deletes stashed work."
fi

# --- Blocked only while local work would be lost ----------------------------

destructive=""
if printf '%s' "$cmd" | grep -Eq 'git\b[^|;&]*\breset\b[^|;&]*--(hard|merge)\b'; then
  destructive="'git reset --hard/--merge' discards uncommitted changes and can orphan unpushed commits"
elif printf '%s' "$cmd" | grep -Eq 'git\b[^|;&]*\bcheckout\b[^|;&]*(\s--(\s|$)|\s-[a-zA-Z]*f\b|\s--force\b|\s\.(\s|$|[;&|]))'; then
  destructive="'git checkout -f / -- <path> / .' overwrites uncommitted changes"
elif printf '%s' "$cmd" | grep -Eq 'git\b[^|;&]*\bcheckout\b[^|;&]*\s-B\b'; then
  destructive="'git checkout -B' force-moves a branch and can orphan unpushed commits"
elif printf '%s' "$cmd" | grep -Eq 'git\b[^|;&]*\bswitch\b[^|;&]*(\s-C\b|\s--force\b|\s-[a-zA-Z]*f\b)'; then
  destructive="'git switch -C/--force' can overwrite local changes or orphan unpushed commits"
elif printf '%s' "$cmd" | grep -Eq 'git\b[^|;&]*\bbranch\b[^|;&]*(\s-D\b|\s-[a-zA-Z]*f\b|\s--force\b)'; then
  destructive="'git branch -D/-f' can delete or move a branch holding unpushed commits"
elif printf '%s' "$cmd" | grep -Eq 'git\b[^|;&]*\brestore\b'; then
  if ! printf '%s' "$cmd" | grep -q -- '--staged' || printf '%s' "$cmd" | grep -Eq -- '--worktree|\s-W\b'; then
    destructive="'git restore' discards uncommitted changes in the working tree"
  fi
elif printf '%s' "$cmd" | grep -Eq 'git\b[^|;&]*\bclean\b[^|;&]*\s-[a-zA-Z]*[fdxX]'; then
  destructive="'git clean -f/-d/-x' permanently deletes untracked files"
fi

[ -z "$destructive" ] && exit 0

dirty=$(git status --porcelain 2>/dev/null | head -1)
unpushed=$(git log --branches --not --remotes --oneline 2>/dev/null | head -1)

if [ -n "$dirty" ] || [ -n "$unpushed" ]; then
  reason="$destructive."
  [ -n "$dirty" ] && reason="$reason The working tree has uncommitted changes."
  [ -n "$unpushed" ] && reason="$reason There are local commits not pushed to any remote (see: git log --branches --not --remotes --oneline)."
  deny "$reason"
fi

exit 0
