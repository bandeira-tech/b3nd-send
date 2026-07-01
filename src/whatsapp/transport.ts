/**
 * WhatsApp inbound HTTP transport.
 *
 * Structurally this is a **move transport**, not a sink helper — it
 * receives an HTTP request, decodes a wire format (Meta's webhook
 * envelope) into `Output[]`, and forwards into a downstream rig. The
 * only reason it lives in `b3nd-send/whatsapp` today is to avoid
 * forking `b3nd-move` in a stop-gap iteration; the shape here is the
 * spec for the eventual move-side implementation.
 *
 * The transport is HTTP-framework-agnostic: it returns a standard
 * `fetch(req: Request) => Response` handler that drops into
 * Cloudflare Workers, Deno.serve, Hono, Bun, etc.
 */

import type { Output } from "@bandeira-tech/b3nd-core";
import type { WhatsAppWebhook } from "./webhook.ts";

export interface WhatsAppHttpServiceConfig {
  /**
   * The webhook bundle from a `createWhatsAppSink` (or a standalone
   * `createWebhook`) instance. Provides verify (GET handshake),
   * verifySignature, and parse.
   */
  webhook: WhatsAppWebhook;
  /**
   * Where to dispatch decoded tuples. Typically `rig.receive.bind(rig)`
   * for a real B3nd rig; tests pass a recording function.
   *
   * Errors thrown here bubble up — the transport translates them to
   * `502 Bad Gateway` so the downstream node sees them in logs but
   * Meta retries the webhook delivery rather than treating it as a
   * permanent failure.
   */
  receive: (msgs: Output[]) => unknown | Promise<unknown>;
  /**
   * Path prefix that the transport listens on. Defaults to `/whatsapp`.
   * Set to `""` to mount at the root. The fetch handler returns `null`
   * for paths outside this prefix so callers can compose multiple
   * services on one Worker.
   */
  pathPrefix?: string;
}

export interface WhatsAppHttpService {
  /**
   * Standard `fetch` handler.
   *
   * Routing under `<pathPrefix>` (default `/whatsapp`):
   *   GET  → Meta's handshake. Returns 200 with the challenge, 403 on
   *          token mismatch.
   *   POST → signature verify + envelope decode + downstream receive.
   *          Returns 200 on success, 401 on bad signature, 400 on
   *          malformed body, 502 if the downstream `receive` throws.
   *   Other methods on the prefix → 405.
   *   Other paths → returns null. Caller composes their own response
   *          (e.g. a 404, or another route handler).
   */
  fetch(req: Request): Promise<Response | null>;
}

export function createWhatsAppHttpService(
  config: WhatsAppHttpServiceConfig,
): WhatsAppHttpService {
  const { webhook, receive } = config;
  const pathPrefix = config.pathPrefix ?? "/whatsapp";

  return {
    async fetch(req) {
      const url = new URL(req.url);
      if (!matchesPrefix(url.pathname, pathPrefix)) return null;

      if (req.method === "GET") return handleGet(webhook, url);
      if (req.method === "POST") return await handlePost(webhook, receive, req);
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, POST" },
      });
    },
  };
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  if (prefix === "") return true;
  // Match exact prefix or prefix followed by `/` so `/whatsapp/foo`
  // would still belong to this service if we ever add sub-routes.
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function handleGet(webhook: WhatsAppWebhook, url: URL): Response {
  const query = {
    "hub.mode": url.searchParams.get("hub.mode") ?? undefined,
    "hub.verify_token": url.searchParams.get("hub.verify_token") ?? undefined,
    "hub.challenge": url.searchParams.get("hub.challenge") ?? undefined,
  };
  try {
    const challenge = webhook.verify(query);
    if (challenge === null) {
      return new Response("verification failed", { status: 403 });
    }
    return new Response(challenge, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  } catch (err) {
    // verify() throws when verifyToken isn't configured — that's a
    // misconfiguration, not an attacker. Return 500.
    return new Response((err as Error).message, { status: 500 });
  }
}

async function handlePost(
  webhook: WhatsAppWebhook,
  receive: (msgs: Output[]) => unknown | Promise<unknown>,
  req: Request,
): Promise<Response> {
  const rawBody = await req.text();
  const sig = req.headers.get("x-hub-signature-256");

  let tuples: Output[];
  try {
    tuples = await webhook.parse(rawBody, sig);
  } catch (err) {
    const msg = (err as Error).message ?? "parse failed";
    if (msg.includes("signature verification failed")) {
      return new Response("signature verification failed", { status: 401 });
    }
    if (msg.includes("requires an appSecret")) {
      return new Response(msg, { status: 500 });
    }
    return new Response(msg, { status: 400 });
  }

  try {
    await receive(tuples);
  } catch (err) {
    // Meta retries on 5xx; treat downstream failures as transient so
    // we don't drop messages.
    return new Response(
      `downstream receive failed: ${(err as Error).message}`,
      { status: 502 },
    );
  }

  return new Response("ok", { status: 200 });
}
