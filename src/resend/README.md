# resend sink

Transactional email egress via [Resend](https://resend.com). Implements
`ProtocolInterfaceNode` so it composes into a Rig like any other client.

## Usage

```ts
import { createResendSink, URI_EMAILS } from "./mod.ts";

const sink = createResendSink({ apiKey: Deno.env.get("RESEND_API_KEY")! });

const [result] = await sink.receive([[
  URI_EMAILS,
  {
    email: {
      from: "no-reply@yourdomain.com",
      to: "user@example.com",
      subject: "Hello",
      text: "Hi.",
    },
    idempotencyKey: "optional-correlation-id",
  },
]]);

if (!result.accepted) console.error(result.errorDetail);
```

Credentials are injected at construction. No env reads inside the package; the
caller is responsible for sourcing the API key.

## URI

One URI today: `resend://emails`. Writing to anything else is refused with
`INVALID_URI`.

This is deliberately minimal for v0 — see "open questions" below. The URI scheme
is under-utilized; we'll let usage tell us what richer addressing would buy.

## Payload shape

Pass-through. The `email` field is the Resend `POST /emails` body verbatim — see
their API reference. The sink does not validate field values; Resend does, and
validation errors come back as `INVALID_SCHEMA` refusals.

The only sink-owned field is `idempotencyKey`, forwarded as the
`Idempotency-Key` header.

## Throw vs refusal — v0 line

**Throws** (transport-level only):

- `fetch` rejections (network down, DNS failure, TLS, abort).

**Refusals** (`ReceiveResult { accepted: false, errorDetail }`) — every HTTP
response from Resend, mapped onto `ErrorCode`:

| Resend status | `errorDetail.code` |
| ------------- | ------------------ |
| 400, 422      | `INVALID_SCHEMA`   |
| 401           | `UNAUTHORIZED`     |
| 403           | `FORBIDDEN`        |
| 404           | `NOT_FOUND`        |
| 409           | `CONFLICT`         |
| anything else | `STORAGE_ERROR`    |

Why everything-into-refusal? It keeps `receive` 1:1 with input even when one
message in a batch fails for a programmer-error reason (unverified `from`, wrong
API key). Callers switch on `errorDetail.code`.

Where this diverges from VISION's default ("auth errors throw"): we keep auth in
the refusal path so a single bad API key doesn't blow up unrelated messages in
the same batch. If you misconfigured the key, every result will be
`UNAUTHORIZED` — fail fast and loud, just on the result channel rather than the
throw channel.

## Read / observe

Not implemented. Calling `read` or `observe` throws. Resend does have
`GET /emails/:id` and a webhooks surface — we'll add them if a sink that
actually needs them surfaces the design tension.

## Identity

API key at construction. `from` lives in the payload, so one sink instance can
send from multiple verified domains.

## Idempotency

Caller-owned. Pass `idempotencyKey` on the payload to enable Resend's
deduplication. The sink does not generate keys and does not retry — retries
belong in a layer above.

## Batching

Loop, not `/emails/batch`. Requests fire in parallel via `Promise.all`. We'll
add the batch endpoint when a caller asks.

## Known gap: send id is not surfaced

`ReceiveResult` has no payload slot for success metadata, so Resend's response
`id` is dropped on the floor. If you need the id today, use your own
`idempotencyKey` as the correlation id — Resend honors it. This is the most
concrete pressure point against the URI being so minimal, and is likely where
the next iteration starts.

## Open questions this sink leaves for the next one

- **Richer URIs.** Should the URI carry the recipient, the from-domain, or a
  caller correlation id? Currently it's a bucket.
- **Surfacing provider IDs.** `ReceiveResult` shape doesn't have a slot for
  success metadata. Worth raising upstream once a second sink hits the same
  need.
- **Auth on the throw line.** Per VISION, auth is "programmer error" and
  conventionally throws. We chose refusal for 1:1 hygiene. Revisit when
  comparing against `openrouter` / `whatsapp`.
- **Rate limits.** 429 currently lands in `STORAGE_ERROR`. Probably wants its
  own code or a dedicated surfacing path (Retry-After).
