# CLAUDE.md — b3nd-send

Read [VISION.md](./VISION.md) first. It defines what a sink is and which
design questions are deliberately open.

## How we work in this repo

This package is being built **case by case** to discover the shared
contract empirically. Several sinks are explored in parallel; each one
is its own branch and its own worktree.

### Parallel sinks via worktrees

One branch and one worktree per sink:

```sh
git worktree add .claude/worktrees/<sink-name> -b sink/<sink-name>
```

Work happens inside the worktree. Each worktree is a full copy of the
repo at the branch tip, so it carries this CLAUDE.md and VISION.md
along with it — that's how the "shared base" reaches parallel work.

The sink's code lives under `src/<sink-name>/`. Nothing in another
sink's directory is in scope from inside a worktree. If you find
yourself wanting to edit `src/email/` from the `sink/openrouter`
worktree, stop — that's a signal you're trying to extract a shared
abstraction prematurely (see VISION).

### When the shared base changes

CLAUDE.md and VISION.md evolve on `main`. To pick up updates inside an
existing worktree:

```sh
git fetch origin && git rebase origin/main
```

If a sink's exploration produces a change to VISION (a tension you hit,
a constraint you discovered), land it on `main` via its own small PR —
do not bundle vision changes into a sink PR.

### End of every session

1. Commit, even as `wip:` — a worktree with local-only changes is
   invisible to other parallel work and to future you.
2. Push the branch.
3. If the sink is shippable, open a PR. Remove the worktree only after
   the PR is open or the branch is otherwise persisted.

## Code principles

These hold across every sink. Per-sink choices belong in
`src/<sink-name>/README.md` or `NOTES.md`.

- **No premature abstraction.** Do not extract a `SinkClient` base
  class, a shared mapper interface, or a unified error type until at
  least three sinks have shipped independently and the abstraction is
  obvious. Duplication is cheaper than wrong abstraction.
- **No defaults on required knobs.** Credentials, account IDs, model
  names, from-addresses — all injected. Do not read from environment
  variables inside the package.
- **No serialization inside the sink core.** The sink does the
  service-specific request shaping it must do; it does not impose
  encoding on the caller's payload.
- **Throw vs payload-error: pick the line and document it.** For each
  sink, write down in its README which failures throw and which come
  back as payload. See VISION on why the line is fuzzier here than in
  save/move.
- **No cross-sink imports inside `src/`.** Sinks are independent.

## Relaying B3nd APIs

Before importing from any `@bandeira-tech/b3nd-*` package, follow the
relay protocol in the b3nd skill's `TARGETS.md`: confirm the installed
version, check current exports on JSR or GitHub, then write code. The
core API moves; do not generate import paths from memory.

## What this repo is not, yet

- Not a published package. No JSR release until at least one sink
  works end-to-end against its real service.
- Not a notification library. The point is to discover the egress
  contract across very different services, not to wrap Twilio nicely.
- Not opinionated about identity, idempotency, retries, or batching
  — see VISION for the open questions.

## Release rule

Releasing any `@bandeira-tech` package requires, **same day**: bumping its pin
in every direct workspace consumer and publishing their patch releases. The
`dep-drift` CI job (running on every PR and weekly) fails when a pin lags
JSR latest — a failing dep-drift check blocks the PR.

Run `deno task check:deps` locally before opening a PR that touches pins.
