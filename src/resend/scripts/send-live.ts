/**
 * Live smoke test against the real Resend API.
 *
 * Run from the repo root:
 *
 *   deno task resend:send-live
 *
 * Required env (loaded from `.env`):
 *   RESEND_API_KEY     — your Resend API key
 *
 * Optional env:
 *   RESEND_FROM        — verified sender (default: onboarding@resend.dev,
 *                        which Resend lets you send to your own account
 *                        email without domain verification)
 *   RESEND_TO          — recipient (default: raf@bandeira.tech)
 *   RESEND_SUBJECT     — subject line (default has a timestamp)
 */

import { createResendSink, URI_EMAILS } from "../mod.ts";

const apiKey = Deno.env.get("RESEND_API_KEY");
if (!apiKey) {
  console.error("RESEND_API_KEY missing — set it in .env");
  Deno.exit(1);
}

const from = Deno.env.get("RESEND_FROM") ?? "onboarding@resend.dev";
const to = Deno.env.get("RESEND_TO") ?? "raf@bandeira.tech";
const subject = Deno.env.get("RESEND_SUBJECT") ??
  `b3nd-sink resend smoke ${new Date().toISOString()}`;

const sink = createResendSink({ apiKey });

console.log(`→ sending from=${from} to=${to}`);

const results = await sink.receive([[
  URI_EMAILS,
  {
    email: {
      from,
      to,
      subject,
      text:
        `This is a smoke test from b3nd-sink/resend.\n\nSent at ${new Date().toISOString()}.`,
    },
  },
]]);

const [result] = results;
if (result.accepted) {
  console.log("✓ accepted");
  Deno.exit(0);
} else {
  console.error("✗ refused");
  console.error(JSON.stringify(result.errorDetail, null, 2));
  Deno.exit(1);
}
