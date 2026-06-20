/**
 * whatsapp-rig — a Cloudflare Worker that mounts the b3nd-sink whatsapp
 * client and exposes its surface as HTTP.
 *
 * Routes:
 *   GET /healthz            → 200, JSON of sink.status()
 *   GET /smoke[?to=+E164]   → builds and sends the hello_world template
 *                             to `to` (or WA_TO_DEFAULT), returns the
 *                             ReceiveResult as JSON
 *   *                       → 404
 *
 * The Worker is a deliberately thin shim: it constructs the sink on
 * every request from the bound env, then forwards [uri, payload] tuples
 * through `sink.receive`. There is no Rig persisted across requests —
 * this is the "node up to dream against", and we'll add rig + storage
 * in subsequent iterations once the move-side webhook transport (M3)
 * lands.
 */

import { createWhatsAppSink } from "../../src/whatsapp/mod.ts";
import type { WhatsAppSink } from "../../src/whatsapp/mod.ts";

interface Env {
  /** wrangler.toml var */
  WA_PHONE_NUMBER_ID: string;
  /** wrangler.toml var (optional default for /smoke) */
  WA_TO_DEFAULT?: string;
  /** wrangler secret */
  WA_ACCESS_TOKEN: string;
  /** wrangler secret (optional — required if webhook routes are added) */
  WA_APP_SECRET?: string;
  /** wrangler secret (optional — required if webhook routes are added) */
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

async function handleHealthz(sink: WhatsAppSink): Promise<Response> {
  const status = await sink.status();
  return Response.json(status);
}

async function handleSmoke(
  sink: WhatsAppSink,
  url: URL,
  env: Env,
): Promise<Response> {
  const to = url.searchParams.get("to") ?? env.WA_TO_DEFAULT;
  if (!to) {
    return Response.json(
      { error: "missing `?to=+E164` and WA_TO_DEFAULT not configured" },
      { status: 400 },
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
    let sink: WhatsAppSink;
    try {
      sink = buildSink(env);
    } catch (err) {
      return Response.json(
        { error: (err as Error).message },
        { status: 500 },
      );
    }

    if (url.pathname === "/healthz" && req.method === "GET") {
      return handleHealthz(sink);
    }
    if (url.pathname === "/smoke" && req.method === "GET") {
      return handleSmoke(sink, url, env);
    }

    return Response.json(
      {
        worker: "whatsapp-rig",
        routes: ["GET /healthz", "GET /smoke?to=+E164"],
      },
      { status: 404 },
    );
  },
};
