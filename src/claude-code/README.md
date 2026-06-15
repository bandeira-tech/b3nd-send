# claude-code sink

Egress to **Claude Code** (the Anthropic agent). One URI shape, one
verb: spawn a session.

## Shape

```
URI:     claude-code://run/<runId>     payload: RunRequest
URI:     claude-code://abort/<runId>   payload: ignored
```

```
RunRequest: { prompt, cwd, model?, permissionMode?, allowedTools?, maxTurns? }
```

`<runId>` is supplied by the caller. The sink does not generate it. It's
the correlation key downstream consumers use to associate emitted events
back to the request.

Abort is addressed the same way every other operation is — via `receive`
on a URI. `{accepted: true}` once the signal is fired; `{accepted: false}`
if `<runId>` isn't live. The runner sees the abort through its
`AbortSignal`; any events already forwarded stay forwarded, and the
terminal `summary` event comes through whatever path the runner takes
to exit.

## Lifecycle

`receive()` does **not** block on the session. It validates the URI and
payload, kicks off the runner, and returns immediately:

- `{ accepted: true }` — the run was started.
- `{ accepted: false, error }` — the request was rejected before any
  side effect (bad URI, missing fields, `runId` already in flight).

Session events are forwarded to an **injected PIN** (`config.sink`).
Each event becomes one `receive` call on that PIN under:

```
claude-code://run/<runId>/event/<n>
```

…where `<n>` is a monotonic counter scoped to the run. The terminal
event has `kind: "summary"` and `data` with at least a `stopReason`.

Persistence and access of these events are entirely the downstream PIN's
concern — out of band from this sink. Wire a memory store for tests, a
real B3nd save client for production, a forwarder to push events back
into a Rig, etc.

## Why injected runner

The sink does not import the Claude Agent SDK. Callers inject a
`Runner` — an async generator that yields `RunEvent`s and ends with a
`summary`. That keeps the sink small (~1 file of logic), keeps SDK
version churn out of the package, and makes fakes trivial.

A production runner is a thin wrapper around `@anthropic-ai/claude-agent-sdk`'s
`query()`; a test runner is an inline async generator. Neither lives
in this package.

## Throw vs payload-error line

Per VISION, sinks must document this explicitly. For claude-code:

- **`receive` itself never throws.** Bad URI, missing payload fields,
  duplicate `runId` → `{ accepted: false, error }`. The caller is
  asking the sink to *start a job*; that ask either succeeds or
  doesn't.
- **Runner exceptions never propagate to the caller.** By the time the
  runner is throwing, `receive` has already returned. The exception
  becomes a terminal `summary` event with
  `data.stopReason: "runner_error"` on the downstream PIN.
- **Domain refusals from Claude Code** (max-turns hit, permission
  denied, model refusal) are the runner's own event kinds, ending in a
  `summary` with whatever `stopReason` the runner chose.

That means a caller waiting on the downstream PIN sees a terminal
`summary` event for every started run, no matter how it ended.

## Not implemented (yet)

- `read` / `observe` — throw. Session state lives in the downstream
  PIN; query it there.
- Resume / continue. The URI scheme leaves room for
  `claude-code://resume/<sessionId>` but it's not wired.
- Streaming partial token output. The runner can yield finer-grained
  events; the sink doesn't care about granularity.

## Open questions surfaced so far

1. Should the runner be passed at construction, or per-request inside
   the payload? Per-request would let one sink instance multiplex
   different runners (subprocess vs SDK vs fake). Probably wrong, but
   noted.
2. Should `accepted: true` carry the synthesized first event URI so the
   caller knows where to start tailing? Currently no — the caller
   already knows `runId`.
3. Backpressure. The downstream PIN's `receive` is awaited, so a slow
   PIN throttles the runner. Is that the right coupling, or should the
   sink buffer? Wait until we see a slow PIN.
