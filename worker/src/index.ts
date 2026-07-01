/**
 * whatsapp-rig — a Cloudflare Worker that mounts the b3nd-send whatsapp
 * client and exposes its surface as HTTP.
 *
 * Routes:
 *   GET  /healthz            → 200, JSON of sink.status()
 *   GET  /smoke[?to=+E164]   → builds and sends the hello_world template
 *                              to `to` (or WA_TO_DEFAULT), returns the
 *                              ReceiveResult as JSON
 *   GET  /whatsapp           → Meta webhook GET handshake (verify_token)
 *   POST /whatsapp           → Meta webhook POST: HMAC verify → decode →
 *                              dispatch to downstream `receive`
 *   *                        → 404
 *
 * The Worker is a deliberately thin shim: it constructs the sink on
 * every request from the bound env, then forwards [uri, payload] tuples
 * through `sink.receive` (outbound) or through the move-style HTTP
 * transport (inbound). There is no Rig persisted across requests —
 * inbound tuples are currently console-logged. Rig wiring (storage,
 * observers) comes once we know what backend to wire in.
 */

import {
  createWebhook,
  createWhatsAppHttpService,
  createWhatsAppSink,
  whatsappUris,
} from "../../src/whatsapp/mod.ts";
import type {
  WhatsAppHttpService,
  WhatsAppSink,
  WhatsAppWebhook,
} from "../../src/whatsapp/mod.ts";

interface Env {
  /** wrangler.toml var */
  WA_PHONE_NUMBER_ID: string;
  /** wrangler.toml var (optional default for /smoke) */
  WA_TO_DEFAULT?: string;
  /** wrangler secret */
  WA_ACCESS_TOKEN: string;
  /** wrangler secret — required for /whatsapp POST */
  WA_APP_SECRET?: string;
  /** wrangler secret — required for /whatsapp GET handshake */
  WA_VERIFY_TOKEN?: string;
}

function buildSink(env: Env): WhatsAppSink {
  if (!env.WA_PHONE_NUMBER_ID) {
    throw new Error("worker: WA_PHONE_NUMBER_ID var not configured");
  }
  if (!env.WA_ACCESS_TOKEN) {
    throw new Error("worker: WA_ACCESS_TOKEN secret not configured");
  }
  return createWhatsAppSink({
    phoneNumberId: env.WA_PHONE_NUMBER_ID,
    accessToken: env.WA_ACCESS_TOKEN,
    appSecret: env.WA_APP_SECRET,
    verifyToken: env.WA_VERIFY_TOKEN,
  });
}

function buildWebhook(env: Env): WhatsAppWebhook {
  return createWebhook({
    appSecret: env.WA_APP_SECRET,
    verifyToken: env.WA_VERIFY_TOKEN,
  });
}

function buildWebhookService(env: Env): WhatsAppHttpService {
  return createWhatsAppHttpService({
    webhook: buildWebhook(env),
    pathPrefix: "/whatsapp",
    // No Rig yet — log the tuples so we can verify ingress via
    // `wrangler tail` once Meta points its webhook here.
    receive: (tuples) => {
      for (const [uri, payload] of tuples) {
        console.log("inbound", uri, JSON.stringify(payload));
      }
    },
  });
}

async function handleHealthz(): Promise<Response> {
  // Don't require the access-token secret for healthz — produce the
  // status manifest from the URI surface alone.
  const uris = whatsappUris();
  return Response.json({
    status: "healthy",
    message: `whatsapp-rig worker mounted at '${uris.basePath}'`,
    schema: [uris.messagesPattern, uris.inboundPattern, uris.statusPattern],
  });
}

async function handleSmoke(url: URL, env: Env): Promise<Response> {
  const to = url.searchParams.get("to") ?? env.WA_TO_DEFAULT;
  if (!to) {
    return Response.json(
      { error: "missing `?to=+E164` and WA_TO_DEFAULT not configured" },
      { status: 400 },
    );
  }
  let sink: WhatsAppSink;
  try {
    sink = buildSink(env);
  } catch (err) {
    return Response.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }

  const [result] = await sink.receive([[
    sink.uris.messages(to),
    {
      message: {
        type: "template",
        template: { name: "hello_world", language: { code: "en_US" } },
      },
    },
  ]]);

  return Response.json(
    { to, basePath: sink.uris.basePath, result },
    { status: result.accepted ? 200 : 502 },
  );
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Healthz — no secrets needed.
    if (url.pathname === "/healthz" && req.method === "GET") {
      return handleHealthz();
    }
    // Smoke — needs the access token; asserts inside the handler.
    if (url.pathname === "/smoke" && req.method === "GET") {
      return handleSmoke(url, env);
    }
    // Inbound — needs appSecret/verifyToken; the transport surfaces
    // those as 500/403/401 as appropriate. Routing lives in the service.
    const service = buildWebhookService(env);
    const transportRes = await service.fetch(req);
    if (transportRes) return transportRes;

    return Response.json(
      {
        worker: "whatsapp-rig",
        routes: [
          "GET /healthz",
          "GET /smoke?to=+E164",
          "GET /whatsapp (Meta handshake)",
          "POST /whatsapp (Meta event delivery)",
        ],
      },
      { status: 404 },
    );
  },
};
