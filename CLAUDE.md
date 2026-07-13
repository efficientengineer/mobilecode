# CLAUDE.md

Guidance for Claude Code (and other coding agents) working in this repository.

## Git safety rules (non-negotiable)

These rules exist because local feature work was once destroyed by syncing
`main` to the remote. A PreToolUse hook (`.claude/hooks/git-safety.sh`)
enforces most of them mechanically; follow them even where it doesn't.

1. **Never develop directly on `main`.** Create a feature branch before the
   first edit. If you find uncommitted work or unpushed commits sitting on
   `main`, your first action is to preserve them (commit, then
   `git branch <feature-name>`), not to sync `main`.

2. **Local state is the source of truth for "did we ship?"** Before saying
   work is or isn't on the remote, check both:
   - `git status` — uncommitted changes
   - `git log --branches --not --remotes --oneline` — commits on any local
     branch that exist on no remote

   If either shows anything, that work exists ONLY on this machine. Answering
   the question never requires modifying the working tree or moving branches.

3. **Never run destructive git commands while unpushed or uncommitted work
   exists.** Destructive means anything that can discard state:
   `git reset --hard`, `git checkout -- <path>` / `git checkout .` /
   `checkout -f` / `checkout -B`, `git switch -C`, `git restore`,
   `git clean -f/-d/-x`, `git branch -D/-f`, `git stash drop/clear`,
   `git push --force` (use `--force-with-lease` if a force push is ever
   needed).

4. **Syncing with the remote must be non-destructive.** To update from
   `origin/main`, use `git fetch origin main` and then merge or rebase your
   feature branch onto it. Never "reset to remote" (`git reset --hard
   origin/main`, `git checkout -B main origin/main`) as a way to sync — that
   is how local work gets destroyed.

5. **Discarding work requires explicit user confirmation, and a backup
   first.** Even when the user says to discard, create a safety net before
   doing it: `git branch backup/$(date +%Y%m%d-%H%M%S)` (and/or
   `git stash push -u -m "backup"`). Mention the backup ref so the user can
   recover later.

6. **Commit early, push often.** Completed logical units of work should be
   committed immediately and pushed to a remote feature branch in the same
   session. Unpushed work is one bad command away from being unrecoverable.

### If work appears to be lost

Do not run any further destructive commands. Recover with:
- `git reflog` — every position HEAD has been at; committed work is almost
  always still reachable here for ~90 days.
- `git fsck --lost-found` — dangling commits/blobs no ref points to.
- `git stash list` — forgotten stashes.

Restore with `git branch recovered <sha>` from a reflog/fsck SHA.
