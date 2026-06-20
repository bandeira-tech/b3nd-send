# whatsapp sink

WhatsApp Cloud API egress + inbound webhook parsing. Implements
`ProtocolInterfaceNode` so the egress side composes into a Rig like any
other client; the webhook side is exposed as a separate helper that
returns B3nd tuples, keeping the sink HTTP-framework-agnostic.

This sink is the first one in `b3nd-sink` to be **bidirectional** — it's
deliberately chosen to surface the design tension VISION calls out
("what does a bidirectional sink look like").

## Usage

### Outbound

```ts
import { createWhatsAppSink } from "./mod.ts";

const sink = createWhatsAppSink({
  phoneNumberId: Deno.env.get("WA_PHONE_NUMBER_ID")!,
  accessToken: Deno.env.get("WA_ACCESS_TOKEN")!,
  appSecret: Deno.env.get("WA_APP_SECRET")!,
  verifyToken: Deno.env.get("WA_VERIFY_TOKEN")!,
  // basePath defaults to `whatsapp://`. Override to mount elsewhere.
});

const [result] = await sink.receive([[
  sink.uris.messages("+15555550100"),
  {
    message: { type: "text", text: { body: "Hello from B3nd" } },
    bizOpaqueCallbackData: "corr-1",
  },
]]);

if (!result.accepted) console.error(result.errorDetail);
```

### Mounting under a different basePath

Per b3nd-skill's PROTOCOL.md ("Mount basepaths so users keep control of
their data"), the sink's URI prefix is configurable. The shape on the
wire is identical; what changes is *where on the rig* the sink lives:

```ts
import { createWhatsAppSink, whatsappUris } from "./mod.ts";

const sink = createWhatsAppSink({
  ...,
  basePath: "signed://0xabc.../whatsapp/",
});

// URI helpers are the only public way to build URIs:
const uris = whatsappUris("signed://0xabc.../whatsapp/");
await sink.receive([[uris.messages("+15555550100"), { message: ... }]]);

// Or use sink.uris (bound to the sink's own basePath):
await sink.receive([[sink.uris.messages("+15555550100"), { message: ... }]]);
```

Hard-coding `"whatsapp://messages/..."` in caller code is a leak —
breaks the mount-point abstraction and prevents multi-tenancy on the
same rig. The factory validates basePath (must end with `/`, must
contain `://`) and surfaces it in `status().message` and
`status().schema`.

### Inbound webhook

The sink exposes `webhook.verify` (GET handshake), `webhook.verifySignature`,
and `webhook.parse`. Wire them into whatever HTTP framework you use:

```ts
// GET handshake
const challenge = sink.webhook.verify(Object.fromEntries(url.searchParams));
if (challenge) return new Response(challenge);

// POST event
const rawBody = await req.text();
const sig = req.headers.get("x-hub-signature-256");
const tuples = await sink.webhook.parse(rawBody, sig);
// tuples: Output<NormalizedInbound>[]
//   [whatsapp://inbound/<E164>,  { kind: "message", ... }]
//   [whatsapp://status/<wamid>, { kind: "status",  ... }]
await rig.receive(tuples);
```

`webhook.parse` returns tuples rather than pushing them into a node so
the sink stays decoupled from your transport. For the common case —
parsing a request and forwarding to a rig — see `createWhatsAppHttpService`
below.

### HTTP transport (move-shaped)

`createWhatsAppHttpService` wraps the webhook with a `fetch(req) =>
Response | null` handler that drops into any framework with the
Fetch API: Cloudflare Workers, `Deno.serve`, Hono, Bun. It owns the
GET handshake, signature verification, envelope decode, and forwarding
into a downstream `receive` (typically `rig.receive.bind(rig)`).

```ts
import { createWebhook, createWhatsAppHttpService } from "./mod.ts";

const webhook = createWebhook({
  appSecret: env.WA_APP_SECRET,
  verifyToken: env.WA_VERIFY_TOKEN,
});

const service = createWhatsAppHttpService({
  webhook,
  receive: (tuples) => rig.receive(tuples),
  pathPrefix: "/whatsapp", // optional; default `/whatsapp`
});

export default {
  async fetch(req: Request): Promise<Response> {
    const res = await service.fetch(req);
    return res ?? new Response("not found", { status: 404 });
  },
};
```

Status codes:

| Situation                            | Code |
| ------------------------------------ | ---- |
| GET handshake, token matches         | 200  |
| GET handshake, token mismatch        | 403  |
| POST, signature verifies + parses    | 200  |
| POST, signature mismatch             | 401  |
| POST, valid signature, bad JSON      | 400  |
| POST, downstream `receive` throws    | 502 (Meta retries) |
| Method not GET/POST                  | 405  |
| Misconfiguration (no appSecret/verifyToken) | 500 |
| Path outside `pathPrefix`            | returns `null` so the caller composes their own response |

**Why this is structurally a `b3nd-move` transport, not a sink helper.**
Move's job is to bridge a wire format ↔ a mounted rig. The whatsapp
webhook fits that mould exactly — it's just HTTP with a Meta-specific
envelope, HMAC-signed body, and a one-off verification handshake. The
service lives in `b3nd-sink/whatsapp` for now because forking
`b3nd-move` for a single stop-gap iteration would stall this work; the
shape here is the spec for the eventual move-side implementation. The
encoder pieces (`webhook.verifySignature`, `webhook.parse`) stay where
they are even once the transport moves — they're the wire dialect, not
the HTTP plumbing.

Credentials are injected at construction. No env reads inside the
package.

## URIs

Default basePath is `whatsapp://` (overridable; see "Mounting under a
different basePath" above).

| URI shape                          | Direction | Source                       |
| ---------------------------------- | --------- | ---------------------------- |
| `<basePath>messages/<E164>`        | write     | caller → `receive`           |
| `<basePath>inbound/<E164>`         | inbound   | webhook → `webhook.parse`    |
| `<basePath>status/<wamid>`         | inbound   | webhook → `webhook.parse`    |

The three sub-prefixes are deliberately split so apps route them
through distinct downstream nodes (an inbound message and a delivery
status are not the same thing).

Build URIs via the exported helpers — never concatenate `basePath`
yourself:

```ts
sink.uris.messages("+15555550100")     // → <basePath>messages/+15555550100
sink.uris.inbound("+15555550100")      // → <basePath>inbound/+15555550100
sink.uris.status("wamid.xyz")          // → <basePath>status/wamid.xyz
sink.uris.messagesPattern              // → <basePath>messages/**
```

## Payload shape

### Outbound — `WhatsAppSendPayload`

```ts
{
  message: WhatsAppMessage,   // { type, text|template|image|... }
  contextMessageId?: string,  // → context.message_id (reply threading)
  bizOpaqueCallbackData?: string,
}
```

`message` is pass-through onto Meta's `POST /messages` body, minus
`messaging_product` and `to` which the sink supplies (`to` comes from
the URI). The sink does **not** validate field values; Meta does, and
validation errors come back as `INVALID_SCHEMA` refusals.

### Inbound — `NormalizedInbound`

The sink normalizes Meta's nested envelope into one tuple per message
or status. The shapes are flat (`from`, `to`, `text`, `messageId`,
`timestamp`, `type`) with the original Meta object kept on `raw` for
escape hatches.

Webhook bodies that contain multiple inner events fan out to multiple
tuples — the 1:1 with input is at the *tuple* level, not the HTTP
request.

## Throw vs refusal — v0 line

**Throws** (transport / programmer-error / security):

- `fetch` rejections on outbound (network down, DNS, TLS, abort)
- Missing config used at call time (`appSecret` for `webhook.parse`,
  `verifyToken` for `webhook.verify`)
- Webhook signature mismatch — treated as an attack-surface concern,
  not a domain refusal. Bubbling it up forces the caller to deal with
  it loudly.
- Malformed JSON in a webhook body

**Refusals** (`ReceiveResult { accepted: false, errorDetail }`) — every
HTTP response from Meta, mapped onto `ErrorCode`:

| Meta status | `errorDetail.code` |
| ----------- | ------------------ |
| 400, 422    | `INVALID_SCHEMA`   |
| 401         | `UNAUTHORIZED`     |
| 403         | `FORBIDDEN`        |
| 404         | `NOT_FOUND`        |
| 409         | `CONFLICT`         |
| **429**     | `STORAGE_ERROR`    |
| 5xx         | `STORAGE_ERROR`    |

### The deliberate call: 429 is a refusal, not a throw

A 429 from Meta is "you sent too fast" — the same call would succeed
later. Putting it on the refusal side means a single rate-limited
message in a batch doesn't blow up the others, and callers can branch
on `errorDetail.code` to decide whether to retry without writing a
try/catch around `receive`. Retry policy stays a layer above; the sink
only signals.

If a future sink shows that callers always want `RATE_LIMITED` distinct
from `STORAGE_ERROR`, that's a vote for a new `ErrorCode` upstream in
b3nd-core rather than a sink-local invention.

### The other deliberate call: webhook signature errors throw

Symmetric to the above. A 401 from Meta could be a misconfigured key in
one of many messages; surfacing it as a refusal keeps batches honest. A
bad webhook signature is not a per-message domain problem — it means
something is wrong with the request itself, and silently accepting it
would be a security defect. Throw, loudly.

## Identity

Phone number id + access token at construction. One sink instance
serves one Meta phone number id. Multi-tenant apps build one sink per
tenant for now.

## Idempotency, retries, batching

- **Idempotency**: not surfaced. Meta's API does not advertise an
  idempotency key for sends; `bizOpaqueCallbackData` is the closest
  analog and is forwarded as-is so callers can correlate sends with
  delivery statuses arriving on `whatsapp://status/<wamid>`.
- **Retries**: caller-owned. The sink never retries.
- **Batching**: loop, not a batch endpoint (Meta does not have one for
  `/messages`). Requests fire in parallel via `Promise.all`.

## Read / observe

Not implemented. Meta does have a read surface (templates list,
business profile, message threads via webhooks) — we deferred it
deliberately. The interesting question is whether read on whatsapp
belongs in the sink at all, or in a separate "external read" client.
We'll let `openrouter` weigh in.

## Open questions this sink leaves for the next one

- **Templated message helpers.** Template `components` is `Array<Record>`
  today — typed builders are tempting but premature; revisit once an app
  actually composes more than one or two of them.
- **Where does `appSecret` live?** Two natural shapes: on the sink (one
  object does both directions, as today), or a separate
  `createWhatsAppWebhook` factory (so send-only apps don't carry
  webhook config). We picked the unified one to test whether apps that
  *only send* find the optional fields awkward.
- **Media upload.** Almost certainly its own URI (`whatsapp://media`)
  when we tackle it — `/messages` only takes `id` or `link`, so the
  upload has to be a prior call.
- **Rate-limit code.** 429 → `STORAGE_ERROR` is honest but lossy. See
  above — wait for a second sink to agree before adding `RATE_LIMITED`.
- **Webhook errors and account_review_update.** Currently silently
  dropped by `parse`. Surface as their own URI when an app needs them.
