---
name: librarian
description: "Cache and refresh remote git repositories under ~/.cache/checkouts/<host>/<org>/<repo> so future references can reuse a local copy. Use this skill when the user points you to a remote git repository as reference or you encountered a remote git repo through other means."
---

Use this skill when the user points you to a remote git repository (GitHub/GitLab/Bitbucket URLs, `git@...`, or `owner/repo` shorthand).

The goal is to keep a reusable local checkout that is:
- **stable** (predictable path)
- **up to date** (periodic fetch + fast-forward when safe)
- **efficient** (partial clone with `--filter=blob:none`, no repeated full clones)

## Cache location

Repositories are stored at:

`~/.cache/checkouts/<host>/<org>/<repo>`

Example:

`github.com/mitsuhiko/minijinja` → `~/.cache/checkouts/github.com/mitsuhiko/minijinja`

## Command

This Pi installation runs normal shell tools inside Gondolin, whose network proxy blocks Git's HTTPS POST requests. Run the checkout helper on the host with the `host_bash` tool:

```bash
bash ~/.pi/agent/skills/librarian/checkout.sh <repo> --path-only
```

Examples:

```bash
bash ~/.pi/agent/skills/librarian/checkout.sh mitsuhiko/minijinja --path-only
bash ~/.pi/agent/skills/librarian/checkout.sh github.com/mitsuhiko/minijinja --path-only
bash ~/.pi/agent/skills/librarian/checkout.sh https://github.com/mitsuhiko/minijinja --path-only
```

The host's `~/.cache/checkouts` is mounted at the VM user's `~/.cache/checkouts`. Use the VM path with `read`, `bash`, `grep`, and other VM tools. Do not run the helper with the VM `bash` tool.

The script will:
1. Parse the repo reference into host/org/repo.
2. Clone if missing.
3. Reuse existing checkout if present.
4. Fetch from `origin` when stale (default interval: 300s).
5. Attempt a fast-forward merge if the checkout is clean and has an upstream.

## Update strategy

- Default behavior is **throttled refresh** (every 5 minutes) to avoid unnecessary network calls.
- Force immediate refresh with:

```bash
bash ~/.pi/agent/skills/librarian/checkout.sh <repo> --force-update --path-only
```

## Recommended workflow

1. Resolve repository path via `checkout.sh --path-only`.
2. Use that path for searching, reading, and analysis.
3. On later references to the same repo, call `checkout.sh` again; it will find and update the cached checkout.

## If edits are needed

Prefer not to edit directly in the shared cache. Create a separate worktree or copy from the cached checkout for task-specific modifications.

## Notes

- `owner/repo` defaults to `github.com`.
