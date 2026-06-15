import { assert, assertEquals } from "@std/assert";
import { ClaudeCodeSink } from "./client.ts";
import type { RunEvent, Runner } from "./types.ts";

/**
 * Recorder PIN. Captures every emit and exposes `awaitSummary(runId)` —
 * a Promise that resolves when a terminal `summary` event lands for the
 * given runId. The test owns its own latch (option C from the design
 * discussion), so it works for every termination path: real summary,
 * runner returned without summary, runner threw, abort.
 */
class Recorder {
  events: [string, unknown][] = [];
  #waiters = new Map<string, { resolve: () => void; promise: Promise<void> }>();

  receive(msgs: [string, unknown][]) {
    for (const m of msgs) {
      this.events.push(m);
      const [uri, payload] = m;
      if ((payload as RunEvent | undefined)?.kind === "summary") {
        const runId = uri.split("/")[3];
        this.#waiters.get(runId)?.resolve();
      }
    }
    return Promise.resolve(msgs.map(() => ({ accepted: true })));
  }

  awaitSummary(runId: string): Promise<void> {
    const existing = this.#waiters.get(runId);
    if (existing) return existing.promise;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#waiters.set(runId, { promise, resolve });
    return promise;
  }

  eventsFor(runId: string): RunEvent[] {
    const prefix = `claude-code://run/${runId}/event/`;
    return this.events
      .filter(([uri]) => uri.startsWith(prefix))
      .map(([, payload]) => payload as RunEvent);
  }
}

const trivialReq = { prompt: "hi", cwd: "/tmp" };

Deno.test("happy path: events forward in order, summary terminates", async () => {
  const rec = new Recorder();
  const runner: Runner = async function* () {
    yield { kind: "assistant", data: { text: "hello" } };
    yield { kind: "tool_use", data: { name: "read" } };
    yield { kind: "summary", data: { stopReason: "end_turn" } };
  };
  const sink = new ClaudeCodeSink({ sink: rec, runner });

  const [ack] = await sink.receive([["claude-code://run/r1", trivialReq]]);
  assert(ack.accepted);

  await rec.awaitSummary("r1");
  const events = rec.eventsFor("r1");
  assertEquals(events.map((e) => e.kind), ["assistant", "tool_use", "summary"]);
});

Deno.test("runner returns without summary → synthesized summary", async () => {
  const rec = new Recorder();
  const runner: Runner = async function* () {
    yield { kind: "assistant", data: { text: "oops" } };
    // No summary.
  };
  const sink = new ClaudeCodeSink({ sink: rec, runner });

  await sink.receive([["claude-code://run/r2", trivialReq]]);
  await rec.awaitSummary("r2");

  const events = rec.eventsFor("r2");
  assertEquals(events.length, 2);
  assertEquals(events[1].kind, "summary");
  assertEquals(
    (events[1].data as { stopReason: string }).stopReason,
    "runner_returned_without_summary",
  );
});

Deno.test("runner throws → synthesized error summary, never propagates to receive", async () => {
  const rec = new Recorder();
  const runner: Runner = async function* () {
    yield { kind: "assistant", data: { text: "partial" } };
    throw new Error("boom");
  };
  const sink = new ClaudeCodeSink({ sink: rec, runner });

  // receive itself must NOT throw.
  const [ack] = await sink.receive([["claude-code://run/r3", trivialReq]]);
  assert(ack.accepted);

  await rec.awaitSummary("r3");
  const events = rec.eventsFor("r3");
  assertEquals(events.at(-1)?.kind, "summary");
  const data = events.at(-1)?.data as { stopReason: string; error: string };
  assertEquals(data.stopReason, "runner_error");
  assertEquals(data.error, "boom");
});

Deno.test("abort uri cancels live run; signal propagates to runner", async () => {
  const rec = new Recorder();
  let sawAbort = false;
  const runner: Runner = async function* (_req, signal) {
    yield { kind: "assistant", data: { text: "starting" } };
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => {
        sawAbort = true;
        resolve();
      }, { once: true });
    });
    yield { kind: "summary", data: { stopReason: "aborted" } };
  };
  const sink = new ClaudeCodeSink({ sink: rec, runner });

  await sink.receive([["claude-code://run/r4", trivialReq]]);
  // Microtask flush so the first event lands before we abort.
  await new Promise((r) => setTimeout(r, 0));

  const [abortAck] = await sink.receive([
    ["claude-code://abort/r4", null],
  ]);
  assert(abortAck.accepted);

  await rec.awaitSummary("r4");
  assert(sawAbort);
  const events = rec.eventsFor("r4");
  assertEquals(events.at(-1)?.kind, "summary");
});

Deno.test("abort of unknown runId rejects", async () => {
  const rec = new Recorder();
  const runner: Runner = async function* () {
    yield { kind: "summary", data: {} };
  };
  const sink = new ClaudeCodeSink({ sink: rec, runner });

  const [ack] = await sink.receive([["claude-code://abort/nope", null]]);
  assertEquals(ack.accepted, false);
  assert(ack.error?.includes("no live run"));
});

Deno.test("duplicate runId in flight is rejected", async () => {
  const rec = new Recorder();
  const { promise: hold, resolve: release } = Promise.withResolvers<void>();
  const runner: Runner = async function* () {
    yield { kind: "assistant", data: {} };
    await hold;
    yield { kind: "summary", data: {} };
  };
  const sink = new ClaudeCodeSink({ sink: rec, runner });

  const [first] = await sink.receive([["claude-code://run/dup", trivialReq]]);
  assert(first.accepted);

  const [second] = await sink.receive([["claude-code://run/dup", trivialReq]]);
  assertEquals(second.accepted, false);
  assert(second.error?.includes("already in progress"));

  release();
  await rec.awaitSummary("dup");
});

Deno.test("bad payload rejected: missing prompt", async () => {
  const rec = new Recorder();
  const sink = new ClaudeCodeSink({
    sink: rec,
    runner: async function* () {
      yield { kind: "summary", data: {} };
    },
  });

  const [ack] = await sink.receive([
    ["claude-code://run/bad", { cwd: "/tmp" } as never],
  ]);
  assertEquals(ack.accepted, false);
  assertEquals(rec.events.length, 0);
});

Deno.test("unsupported uri rejected", async () => {
  const rec = new Recorder();
  const sink = new ClaudeCodeSink({
    sink: rec,
    runner: async function* () {
      yield { kind: "summary", data: {} };
    },
  });

  const [ack] = await sink.receive([["mailto://nope", trivialReq]]);
  assertEquals(ack.accepted, false);
  assert(ack.error?.includes("unsupported uri"));
});
