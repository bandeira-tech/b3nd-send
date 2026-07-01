/**
 * Live smoke test against the real WhatsApp Cloud API.
 *
 * Run from the repo root:
 *
 *   deno task whatsapp:send-live
 *
 * Required env (loaded from `.env`):
 *   WA_PHONE_NUMBER_ID   — Meta phone-number-id used as the path segment
 *   WA_ACCESS_TOKEN      — Graph API token (System User or temporary)
 *   WA_TO                — recipient in E.164 form, e.g. +15555550100
 *
 * Optional env:
 *   WA_TEMPLATE_NAME     — if set, sends a template message instead of
 *                          text (defaults to the approved `hello_world`
 *                          template Meta ships on every test number)
 *   WA_TEMPLATE_LANG     — template language code (default: en_US)
 *   WA_TEXT              — body for the text message (default has a
 *                          timestamp); ignored when WA_TEMPLATE_NAME is
 *                          set
 *   WA_GRAPH_VERSION     — override Graph version (default: v21.0)
 *
 * Note: outside the 24-hour customer-service window WhatsApp only
 * delivers template messages, so brand-new test numbers should leave
 * WA_TEMPLATE_NAME unset (defaults to `hello_world`) on the first run.
 */

import { createWhatsAppSink } from "../mod.ts";
import type { WhatsAppMessage } from "../mod.ts";

const phoneNumberId = Deno.env.get("WA_PHONE_NUMBER_ID");
const accessToken = Deno.env.get("WA_ACCESS_TOKEN");
const to = Deno.env.get("WA_TO");

if (!phoneNumberId || !accessToken || !to) {
  console.error(
    "WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN, WA_TO are required — set them in .env",
  );
  Deno.exit(1);
}

const templateName = Deno.env.get("WA_TEMPLATE_NAME") ?? "hello_world";
const templateLang = Deno.env.get("WA_TEMPLATE_LANG") ?? "en_US";
const text = Deno.env.get("WA_TEXT") ??
  `b3nd-send whatsapp smoke ${new Date().toISOString()}`;
const graphVersion = Deno.env.get("WA_GRAPH_VERSION");

const sink = createWhatsAppSink({
  phoneNumberId,
  accessToken,
  graphVersion,
});

const message: WhatsAppMessage = Deno.env.get("WA_TEXT")
  ? { type: "text", text: { body: text } }
  : {
    type: "template",
    template: { name: templateName, language: { code: templateLang } },
  };

console.log(
  `→ sending phoneNumberId=${phoneNumberId} to=${to} type=${message.type}`,
);

const [result] = await sink.receive([[
  sink.uris.messages(to),
  { message },
]]);

if (result.accepted) {
  console.log("✓ accepted");
  Deno.exit(0);
} else {
  console.error("✗ refused");
  console.error(JSON.stringify(result.errorDetail, null, 2));
  Deno.exit(1);
}
