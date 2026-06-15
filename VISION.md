# Vision — b3nd-sink

`b3nd-sink` is the **egress layer** of B3nd. Where `b3nd-move` is about
transport between B3nd nodes and `b3nd-save` is about persisting payloads
into storage you control, `b3nd-sink` is about handing payloads off to
**external services that B3nd does not own**: an LLM provider, a messaging
gateway, an email API, a payments processor, a calendar.

A sink takes `[uri, payload]` tuples destined for an outside system,
performs whatever side effect that system requires, and returns
`Output[]` describing what happened — the same shape every other piece
of B3nd speaks.

## What "external" means

External services have properties internal B3nd nodes don't:

- **They define their own auth.** API keys, OAuth, webhooks. The sink
  is the boundary that holds those credentials.
- **They define their own data shape.** A sink cannot impose B3nd's
  payload conventions on Stripe or Twilio. The payload-to-request and
  response-to-payload mapping is **per-sink** and is the bulk of the
  work.
- **They are not addressable as B3nd URIs natively.** The sink invents
  a URI convention for the slice of the external surface it exposes
  (`whatsapp://messages/<to>`, `openrouter://chat/<model>`, etc.).
- **They charge money and have rate limits.** Idempotency,
  retry/backoff, and observability are first-class concerns — more so
  than in `save` or `move`.

A sink is the place those concerns live so apps and protocols don't
have to think about them.

## Where the contract is not decided yet

This package is being built **case by case**. The shared contract — the
"SinkClient" interface, if there is one — will be discovered by
implementing several sinks against the bare `ProtocolInterfaceNode`
shape, then extracting what holds. Until then, do not invent a contract.
Specifically, these are **open questions**, not decisions:

- **Receive-only or read + receive?** Some sinks are pure egress (send
  an SMS). Some have a meaningful read surface (list LLM models,
  fetch a message thread). Whether `read` is part of the sink concept
  or a separate "external read" concept is open.
- **Where does identity live?** Per-sink config on construction, or in
  the payload (so the same sink instance can multiplex many accounts)?
  Probably depends on the service — settle it after a few exist.
- **Idempotency, retries, backoff.** Whether the sink owns these or
  whether they're layered above is undecided.
- **Error shape.** B3nd's rule is "transport/programmer errors throw;
  domain refusals live in the payload." For external services the
  line is fuzzier — a 429 is transport-ish, a payment decline is
  domain. Each sink should pick its line explicitly and document it.
- **Batching.** Some external APIs have batch endpoints, some don't.
  Whether the sink advertises batch capability or always loops is
  open.

Resist the urge to prematurely unify. Three working sinks > one elegant
abstraction over zero.

## Framework constraints that *are* fixed

These come from B3nd itself and apply to every sink:

- Messages are `[uri, payload]`. Sinks consume and emit that shape.
- Cryptography stays client-side. Sinks see plaintext payloads only if
  the app fed them plaintext; a sink must not require decryption keys.
- Sinks must be composable as PIN-implementing nodes inside a `Rig` —
  whatever interface emerges, it has to bridge to `ProtocolInterfaceNode`
  cleanly so a sink can drop into a `route` like any other client.
- No globals, no env-var auto-wiring. Credentials and config are
  injected by the caller.

## Layout

Each sink is its own subdirectory under `src/`:

```
src/
  openrouter/
  email/
  whatsapp/
  ...
```

Each subdirectory is self-contained: its own `mod.ts`, its own README,
its own tests, its own notes on the design choices it made. They share
nothing but this VISION until a real abstraction is justified.

## Initial candidates

Picked to span enough of the external-service surface to surface
genuine design tensions, not to ship a notification library:

- **openrouter** — LLM calls. Streaming, model-list reads, tool-use
  responses. Tests "is read part of the sink concept."
- **email** — transactional send (Resend/SMTP). Simplest possible
  egress, useful as a control.
- **whatsapp** — WhatsApp Cloud API. Webhooks (so: inbound, not just
  egress), media payloads, templates. Tests "what does a bidirectional
  sink look like."
- **A non-comms sink** (Stripe or Google Calendar — pick when ready)
  — to confirm the contract isn't accidentally messaging-shaped.

Order is not prescriptive. Pick whatever surfaces the next interesting
question.
