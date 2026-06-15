/**
 * @module
 * Claude Code sink — non-blocking `run` against an injected runner,
 * with session events forwarded to an injected PIN.
 */

import type {
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
} from "@bandeira-tech/b3nd-core";
import type {
  ClaudeCodeSinkConfig,
  RunEvent,
  RunRequest,
  Runner,
} from "./types.ts";

const RUN_URI = /^claude-code:\/\/run\/([^/]+)$/;
const ABORT_URI = /^claude-code:\/\/abort\/([^/]+)$/;

export class ClaudeCodeSink implements ProtocolInterfaceNode {
  readonly #runner: Runner;
  readonly #downstream: ClaudeCodeSinkConfig["sink"];
  readonly #live = new Map<string, AbortController>();

  constructor(config: ClaudeCodeSinkConfig) {
    this.#runner = config.runner;
    this.#downstream = config.sink;
  }

  receive(msgs: Output[]): PromiseLike<ReceiveResult[]> {
    const results: ReceiveResult[] = [];
    for (const [uri, payload] of msgs) {
      const abortMatch = ABORT_URI.exec(uri);
      if (abortMatch) {
        const ctl = this.#live.get(abortMatch[1]);
        if (!ctl) {
          results.push({
            accepted: false,
            error: `no live run: ${abortMatch[1]}`,
          });
          continue;
        }
        ctl.abort();
        results.push({ accepted: true });
        continue;
      }
      const match = RUN_URI.exec(uri);
      if (!match) {
        results.push({
          accepted: false,
          error: `unsupported uri: ${uri}`,
        });
        continue;
      }
      const runId = match[1];
      if (this.#live.has(runId)) {
        results.push({
          accepted: false,
          error: `run already in progress: ${runId}`,
        });
        continue;
      }
      const req = payload as RunRequest;
      if (typeof req?.prompt !== "string" || typeof req?.cwd !== "string") {
        results.push({
          accepted: false,
          error: "payload requires { prompt: string, cwd: string }",
        });
        continue;
      }
      const abort = new AbortController();
      this.#live.set(runId, abort);
      // Fire-and-forget: the whole point is non-blocking. Errors
      // surface to the downstream PIN as a terminal summary event, not
      // to the caller of `receive`.
      this.#drive(runId, req, abort.signal);
      results.push({ accepted: true });
    }
    return Promise.resolve(results);
  }

  read<T = unknown>(): Promise<Output<T>[]> {
    throw new Error("claude-code sink does not implement read");
  }

  // deno-lint-ignore require-yield
  async *observe(): AsyncIterable<readonly string[]> {
    throw new Error("claude-code sink does not implement observe");
  }

  status() {
    return Promise.resolve({
      status: "healthy" as const,
      details: { liveRuns: this.#live.size },
    });
  }

  async #drive(runId: string, req: RunRequest, signal: AbortSignal) {
    let seq = 0;
    const emit = (event: RunEvent) =>
      this.#downstream.receive([[
        `claude-code://run/${runId}/event/${seq++}`,
        event,
      ]]);
    try {
      for await (const event of this.#runner(req, signal)) {
        await emit(event);
        if (event.kind === "summary") return;
      }
      // Runner returned without a summary — synthesize one so consumers
      // always see a terminal marker.
      await emit({
        kind: "summary",
        data: { stopReason: "runner_returned_without_summary" },
      });
    } catch (err) {
      await emit({
        kind: "summary",
        data: {
          stopReason: "runner_error",
          error: err instanceof Error ? err.message : String(err),
        },
      });
    } finally {
      this.#live.delete(runId);
    }
  }
}
