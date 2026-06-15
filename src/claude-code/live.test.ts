/**
 * Live one-off test against the real Claude Agent SDK.
 *
 * Skipped unless `ANTHROPIC_API_KEY` is set in the environment. Run
 * with:
 *
 *   deno task test:live
 *
 * which loads `.env` and grants the permissions the SDK needs.
 *
 * Cost: one trivial chat turn. Pennies. The prompt asks for a one-word
 * reply so the run terminates quickly.
 */

import { assert, assertEquals } from "@std/assert";
import { query } from "npm:@anthropic-ai/claude-agent-sdk";
import { ClaudeCodeSink } from "./client.ts";
import type { RunEvent, Runner } from "./types.ts";

const HAS_KEY = !!Deno.env.get("ANTHROPIC_API_KEY");

/**
 * Adapter from the Agent SDK's `query()` to our `Runner` contract.
 *
 * Lives in the test, not the sink — the sink stays SDK-free.
 */
const sdkRunner: Runner = async function* (req, signal) {
  const stream = query({
    prompt: req.prompt,
    options: {
      cwd: req.cwd,
      model: req.model,
      permissionMode: req.permissionMode,
      allowedTools: req.allowedTools ? [...req.allowedTools] : undefined,
      maxTurns: req.maxTurns,
    },
  });

  signal.addEventListener("abort", () => {
    // `Query` exposes interrupt(); ignore if absent on the runtime
    // shape we got.
    const maybeInterrupt = (stream as unknown as { interrupt?: () => void })
      .interrupt;
    if (typeof maybeInterrupt === "function") maybeInterrupt.call(stream);
  });

  for await (const message of stream) {
    // SDKResultMessage marks end-of-turn — surface it as the sink's
    // terminal `summary` kind so the sink stops tailing.
    if ((message as { type: string }).type === "result") {
      yield { kind: "summary", data: message };
      return;
    }
    yield { kind: (message as { type: string }).type, data: message };
  }
  yield {
    kind: "summary",
    data: { stopReason: "stream_ended_without_result" },
  };
};

class Recorder {
  events: [string, unknown][] = [];
  #waiters = new Map<string, () => void>();

  receive(msgs: [string, unknown][]) {
    for (const m of msgs) {
      this.events.push(m);
      const [uri, payload] = m;
      if ((payload as RunEvent | undefined)?.kind === "summary") {
        const runId = uri.split("/")[3];
        this.#waiters.get(runId)?.();
      }
    }
    return Promise.resolve(msgs.map(() => ({ accepted: true })));
  }

  awaitSummary(runId: string): Promise<void> {
    return new Promise((resolve) => this.#waiters.set(runId, resolve));
  }
}

Deno.test({
  name: "live: real claude-code session drives the sink end-to-end",
  ignore: !HAS_KEY,
  // The SDK can take a while on cold starts.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const rec = new Recorder();
    const sink = new ClaudeCodeSink({ sink: rec, runner: sdkRunner });

    const runId = `live-${Date.now()}`;
    const [ack] = await sink.receive([[
      `claude-code://run/${runId}`,
      {
        prompt: "Reply with exactly the single word OK and nothing else.",
        cwd: Deno.cwd(),
        maxTurns: 1,
      },
    ]]);
    assertEquals(ack.accepted, true);

    await rec.awaitSummary(runId);

    const prefix = `claude-code://run/${runId}/event/`;
    const events = rec.events
      .filter(([uri]) => uri.startsWith(prefix))
      .map(([, p]) => p as RunEvent);

    console.log(
      `[live] received ${events.length} events:`,
      events.map((e) => e.kind),
    );

    assert(events.length > 0, "expected at least one event");
    assertEquals(events.at(-1)?.kind, "summary");
    assert(
      events.some((e) => e.kind === "assistant"),
      "expected at least one assistant event before summary",
    );
  },
});
