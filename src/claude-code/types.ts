/**
 * @module
 * Types for the claude-code sink.
 *
 * The sink consumes one URI shape: `claude-code://run/<runId>`. The
 * caller supplies `<runId>` — it's how downstream consumers reading the
 * injected PIN correlate emitted events back to the request that
 * spawned them.
 */

/**
 * Payload accepted at `claude-code://run/<runId>`.
 *
 * Fields are passed verbatim to the injected runner. The sink does not
 * impose defaults — every knob the runner needs must be present here.
 */
export interface RunRequest {
  prompt: string;
  cwd: string;
  model?: string;
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  allowedTools?: readonly string[];
  maxTurns?: number;
}

/**
 * One event yielded by a runner during a session.
 *
 * The sink treats `kind` opaquely beyond the terminal marker — it just
 * forwards each event to the injected PIN under a per-event URI. The
 * runner decides what to put in `data`; downstream consumers agree with
 * the runner on the shape out-of-band.
 *
 * The runner MUST yield exactly one event with `kind: "summary"` as its
 * last item, then return. The sink uses that to know the session is
 * over.
 */
export interface RunEvent {
  kind: string;
  data: unknown;
}

/**
 * A run-execution function. Injected at sink construction.
 *
 * Throws → the sink treats it as a transport error and emits a single
 * `kind: "summary"` event with `data: { stopReason: "runner_error", error }`.
 * Domain refusals (max-turns, permission denied, model refusal) belong
 * inside the event stream as the runner's own event kinds, terminating
 * with a `summary`.
 */
export type Runner = (
  req: RunRequest,
  signal: AbortSignal,
) => AsyncIterable<RunEvent>;

export interface ClaudeCodeSinkConfig {
  /**
   * Where session events are forwarded. Each event becomes one
   * `receive([[uri, data]])` call on this PIN. The sink does not retain
   * events itself — persistence/access is the injected PIN's concern.
   */
  sink: {
    receive(
      msgs: [uri: string, payload: unknown][],
    ): PromiseLike<unknown>;
  };

  /**
   * Spawns the actual Claude Code session. Inject the real Agent SDK
   * adapter in production; inject a fake in tests.
   */
  runner: Runner;
}
