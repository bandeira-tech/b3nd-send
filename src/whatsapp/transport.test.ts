import { assertEquals } from "@std/assert";
import type { Output } from "@bandeira-tech/b3nd-core";
import {
  createWebhook,
  createWhatsAppHttpService,
  DEFAULT_BASE_PATH,
  inboundUri,
  statusUri,
  type WhatsAppHttpService,
} from "./mod.ts";

const APP_SECRET = "test-secret";
const VERIFY_TOKEN = "vt";

async function signHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface Recorder {
  calls: Output[][];
  receive: (msgs: Output[]) => Promise<void>;
}

function recorder(opts?: { throws?: Error }): Recorder {
  const calls: Output[][] = [];
  return {
    calls,
    receive: (msgs) => {
      calls.push(msgs);
      if (opts?.throws) return Promise.reject(opts.throws);
      return Promise.resolve();
    },
  };
}

function makeService(
  rec: Recorder,
  overrides: { pathPrefix?: string; appSecret?: string; verifyToken?: string } =
    {},
): WhatsAppHttpService {
  // Explicit `in` checks so callers can pass `undefined` to clear a
  // value; bare `??` would fall through to the test default.
  const appSecret = "appSecret" in overrides ? overrides.appSecret : APP_SECRET;
  const verifyToken = "verifyToken" in overrides
    ? overrides.verifyToken
    : VERIFY_TOKEN;
  return createWhatsAppHttpService({
    webhook: createWebhook({ appSecret, verifyToken }),
    receive: rec.receive,
    pathPrefix: overrides.pathPrefix,
  });
}

const sampleEnvelope = {
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "15550001111",
              phone_number_id: "123",
            },
            messages: [
              {
                id: "wamid.IN1",
                from: "15555550100",
                timestamp: "1700000000",
                type: "text",
                text: { body: "hi" },
              },
            ],
            statuses: [
              {
                id: "wamid.OUT1",
                status: "delivered",
                timestamp: "1700000001",
                recipient_id: "15555550100",
              },
            ],
          },
        },
      ],
    },
  ],
};

/* ── GET (handshake) ─────────────────────────────────────────────── */

Deno.test("GET: returns the challenge on a valid token match", async () => {
  const rec = recorder();
  const svc = makeService(rec);
  const res = await svc.fetch(
    new Request(
      "https://w/whatsapp?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=ch-1",
    ),
  );
  assertEquals(res!.status, 200);
  assertEquals(await res!.text(), "ch-1");
  assertEquals(res!.headers.get("content-type"), "text/plain");
});

Deno.test("GET: 403 on token mismatch", async () => {
  const rec = recorder();
  const svc = makeService(rec);
  const res = await svc.fetch(
    new Request(
      "https://w/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=ch-1",
    ),
  );
  assertEquals(res!.status, 403);
});

Deno.test("GET: 500 if verifyToken not configured", async () => {
  const rec = recorder();
  const svc = makeService(rec, { verifyToken: undefined });
  const res = await svc.fetch(
    new Request(
      "https://w/whatsapp?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=ch",
    ),
  );
  assertEquals(res!.status, 500);
});

/* ── POST (event delivery) ───────────────────────────────────────── */

Deno.test("POST: parses + forwards tuples to downstream receive, returns 200", async () => {
  const rec = recorder();
  const svc = makeService(rec);
  const body = JSON.stringify(sampleEnvelope);
  const sig = `sha256=${await signHex(APP_SECRET, body)}`;
  const res = await svc.fetch(
    new Request("https://w/whatsapp", {
      method: "POST",
      headers: { "x-hub-signature-256": sig },
      body,
    }),
  );
  assertEquals(res!.status, 200);
  assertEquals(await res!.text(), "ok");

  assertEquals(rec.calls.length, 1);
  assertEquals(rec.calls[0].length, 2);
  assertEquals(
    rec.calls[0][0][0],
    inboundUri(DEFAULT_BASE_PATH, "15555550100"),
  );
  assertEquals(rec.calls[0][1][0], statusUri(DEFAULT_BASE_PATH, "wamid.OUT1"));
});

Deno.test("POST: 401 on signature mismatch (does not call receive)", async () => {
  const rec = recorder();
  const svc = makeService(rec);
  const res = await svc.fetch(
    new Request("https://w/whatsapp", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=deadbeef" },
      body: JSON.stringify(sampleEnvelope),
    }),
  );
  assertEquals(res!.status, 401);
  assertEquals(rec.calls.length, 0);
});

Deno.test("POST: 400 on malformed JSON (signature valid)", async () => {
  const rec = recorder();
  const svc = makeService(rec);
  const body = "not-json";
  const sig = `sha256=${await signHex(APP_SECRET, body)}`;
  const res = await svc.fetch(
    new Request("https://w/whatsapp", {
      method: "POST",
      headers: { "x-hub-signature-256": sig },
      body,
    }),
  );
  assertEquals(res!.status, 400);
  assertEquals(rec.calls.length, 0);
});

Deno.test("POST: 500 if appSecret not configured", async () => {
  const rec = recorder();
  const svc = makeService(rec, { appSecret: undefined });
  const body = JSON.stringify(sampleEnvelope);
  const res = await svc.fetch(
    new Request("https://w/whatsapp", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=ffff" },
      body,
    }),
  );
  assertEquals(res!.status, 500);
});

Deno.test("POST: 502 when downstream receive throws (Meta will retry)", async () => {
  const rec = recorder({ throws: new Error("storage down") });
  const svc = makeService(rec);
  const body = JSON.stringify(sampleEnvelope);
  const sig = `sha256=${await signHex(APP_SECRET, body)}`;
  const res = await svc.fetch(
    new Request("https://w/whatsapp", {
      method: "POST",
      headers: { "x-hub-signature-256": sig },
      body,
    }),
  );
  assertEquals(res!.status, 502);
  // Parse succeeded, so receive WAS called once before throwing.
  assertEquals(rec.calls.length, 1);
});

/* ── Routing ─────────────────────────────────────────────────────── */

Deno.test("returns null for paths outside the prefix", async () => {
  const rec = recorder();
  const svc = makeService(rec);
  const res = await svc.fetch(new Request("https://w/healthz"));
  assertEquals(res, null);
});

Deno.test("matches the exact prefix path", async () => {
  const rec = recorder();
  const svc = makeService(rec);
  const res = await svc.fetch(
    new Request(
      "https://w/whatsapp?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=x",
    ),
  );
  assertEquals(res!.status, 200);
});

Deno.test("matches sub-paths under the prefix", async () => {
  const rec = recorder();
  const svc = makeService(rec);
  const res = await svc.fetch(
    new Request(
      "https://w/whatsapp/sub?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=y",
    ),
  );
  // Same handlers; the sub-path is forwarded the same way.
  assertEquals(res!.status, 200);
});

Deno.test("does NOT match a path that only shares the prefix as a prefix-of-prefix", async () => {
  const rec = recorder();
  const svc = makeService(rec);
  // `/whatsapp-other` shares the literal text but is a sibling route.
  const res = await svc.fetch(new Request("https://w/whatsapp-other"));
  assertEquals(res, null);
});

Deno.test("respects a custom pathPrefix", async () => {
  const rec = recorder();
  const svc = makeService(rec, { pathPrefix: "/in/wa" });
  const res = await svc.fetch(
    new Request(
      "https://w/in/wa?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=z",
    ),
  );
  assertEquals(res!.status, 200);
});

Deno.test("pathPrefix='' mounts at the root", async () => {
  const rec = recorder();
  const svc = makeService(rec, { pathPrefix: "" });
  const res = await svc.fetch(
    new Request(
      "https://w/?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=q",
    ),
  );
  assertEquals(res!.status, 200);
});

Deno.test("405 on unsupported method under the prefix", async () => {
  const rec = recorder();
  const svc = makeService(rec);
  const res = await svc.fetch(
    new Request("https://w/whatsapp", { method: "PUT" }),
  );
  assertEquals(res!.status, 405);
  assertEquals(res!.headers.get("Allow"), "GET, POST");
});
