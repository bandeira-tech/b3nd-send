import { assertEquals, assertRejects } from "@std/assert";
import { ErrorCode } from "@bandeira-tech/b3nd-core";
import { createResendSink, URI_EMAILS } from "./mod.ts";
import type { ResendPayload } from "./mod.ts";

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

function mockFetch(
  responder: (req: RecordedCall) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const recorded: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(recorded);
    return await responder(recorded);
  };
  return { fetch, calls };
}

const samplePayload: ResendPayload = {
  email: {
    from: "no-reply@example.com",
    to: "user@example.com",
    subject: "hi",
    text: "hello",
  },
};

Deno.test("createResendSink: throws without apiKey", () => {
  let threw = false;
  try {
    createResendSink({ apiKey: "" });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("receive: posts to /emails with bearer auth and JSON body", async () => {
  const { fetch, calls } = mockFetch(() =>
    new Response(JSON.stringify({ id: "abc" }), { status: 200 })
  );
  const sink = createResendSink({
    apiKey: "re_test",
    baseUrl: "https://api.resend.com",
    fetch,
  });

  const results = await sink.receive([[URI_EMAILS, samplePayload]]);

  assertEquals(results, [{ accepted: true }]);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "https://api.resend.com/emails");
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].headers.get("Authorization"), "Bearer re_test");
  assertEquals(calls[0].headers.get("Content-Type"), "application/json");
  assertEquals(JSON.parse(calls[0].body), samplePayload.email);
});

Deno.test("receive: forwards idempotencyKey as Idempotency-Key header", async () => {
  const { fetch, calls } = mockFetch(() =>
    new Response(JSON.stringify({ id: "abc" }), { status: 200 })
  );
  const sink = createResendSink({ apiKey: "re_test", fetch });

  await sink.receive([[URI_EMAILS, {
    ...samplePayload,
    idempotencyKey: "k1",
  }]]);

  assertEquals(calls[0].headers.get("Idempotency-Key"), "k1");
});

Deno.test("receive: omits Idempotency-Key when not provided", async () => {
  const { fetch, calls } = mockFetch(() =>
    new Response(JSON.stringify({ id: "abc" }), { status: 200 })
  );
  const sink = createResendSink({ apiKey: "re_test", fetch });

  await sink.receive([[URI_EMAILS, samplePayload]]);

  assertEquals(calls[0].headers.get("Idempotency-Key"), null);
});

Deno.test("receive: 422 surfaces as INVALID_SCHEMA refusal", async () => {
  const { fetch } = mockFetch(() =>
    new Response(
      JSON.stringify({
        name: "validation_error",
        message: "from address not verified",
        statusCode: 422,
      }),
      { status: 422 },
    )
  );
  const sink = createResendSink({ apiKey: "re_test", fetch });

  const [result] = await sink.receive([[URI_EMAILS, samplePayload]]);

  assertEquals(result.accepted, false);
  assertEquals(result.errorDetail?.code, ErrorCode.INVALID_SCHEMA);
  assertEquals(result.error, "from address not verified");
});

Deno.test("receive: 401 surfaces as UNAUTHORIZED refusal", async () => {
  const { fetch } = mockFetch(() =>
    new Response(JSON.stringify({ message: "invalid api key" }), {
      status: 401,
    })
  );
  const sink = createResendSink({ apiKey: "re_test", fetch });

  const [result] = await sink.receive([[URI_EMAILS, samplePayload]]);

  assertEquals(result.accepted, false);
  assertEquals(result.errorDetail?.code, ErrorCode.UNAUTHORIZED);
});

Deno.test("receive: unknown uri refused without HTTP call", async () => {
  const { fetch, calls } = mockFetch(() =>
    new Response("nope", { status: 500 })
  );
  const sink = createResendSink({ apiKey: "re_test", fetch });

  const [result] = await sink.receive([
    ["resend://unknown", samplePayload],
  ]);

  assertEquals(result.accepted, false);
  assertEquals(result.errorDetail?.code, ErrorCode.INVALID_URI);
  assertEquals(calls.length, 0);
});

Deno.test("receive: missing email field refused without HTTP call", async () => {
  const { fetch, calls } = mockFetch(() =>
    new Response("nope", { status: 500 })
  );
  const sink = createResendSink({ apiKey: "re_test", fetch });

  const [result] = await sink.receive([[URI_EMAILS, {} as ResendPayload]]);

  assertEquals(result.accepted, false);
  assertEquals(result.errorDetail?.code, ErrorCode.INVALID_SCHEMA);
  assertEquals(calls.length, 0);
});

Deno.test("receive: fetch failure propagates (transport throws)", async () => {
  const fetch: typeof globalThis.fetch = () => {
    return Promise.reject(new TypeError("network down"));
  };
  const sink = createResendSink({ apiKey: "re_test", fetch });

  await assertRejects(
    () => sink.receive([[URI_EMAILS, samplePayload]]),
    TypeError,
    "network down",
  );
});

Deno.test("receive: 1:1 results across mixed batch", async () => {
  let n = 0;
  const { fetch } = mockFetch(() => {
    n++;
    if (n === 2) {
      return new Response(JSON.stringify({ message: "bad" }), { status: 422 });
    }
    return new Response(JSON.stringify({ id: `id-${n}` }), { status: 200 });
  });
  const sink = createResendSink({ apiKey: "re_test", fetch });

  const results = await sink.receive([
    [URI_EMAILS, samplePayload],
    [URI_EMAILS, samplePayload],
    [URI_EMAILS, samplePayload],
  ]);

  assertEquals(results.length, 3);
  assertEquals(results[0].accepted, true);
  assertEquals(results[1].accepted, false);
  assertEquals(results[2].accepted, true);
});

Deno.test("read: throws (no read surface)", async () => {
  const sink = createResendSink({ apiKey: "re_test", fetch: globalThis.fetch });
  await assertRejects(() => sink.read([URI_EMAILS]), Error, "no read surface");
});

Deno.test("status: reports egress-only schema", async () => {
  const sink = createResendSink({ apiKey: "re_test", fetch: globalThis.fetch });
  const status = await sink.status();
  assertEquals(status.status, "healthy");
  assertEquals(status.schema, [URI_EMAILS]);
});
