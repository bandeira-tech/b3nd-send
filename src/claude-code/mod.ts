/**
 * @module
 * claude-code sink — fire-and-forget `run` against Claude Code, with
 * session events forwarded to an injected PIN.
 */
export { ClaudeCodeSink } from "./client.ts";
export type {
  ClaudeCodeSinkConfig,
  RunEvent,
  Runner,
  RunRequest,
} from "./types.ts";
