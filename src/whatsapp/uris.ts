/**
 * URI helpers for the whatsapp sink and webhook transport.
 *
 * Per b3nd-skill PROTOCOL.md ("Mount basepaths so users keep control of
 * their data"): URI helpers are the only public way to build URIs.
 * Callers must not concatenate the basePath themselves — that leaks the
 * mount-point abstraction.
 *
 * A whatsapp instance lives under three sub-prefixes off its basePath:
 *
 *   <basePath>messages/<E164>   — outbound, written to by callers
 *   <basePath>inbound/<E164>    — inbound, emitted by webhook decode
 *   <basePath>status/<wamid>    — delivery statuses, emitted by webhook decode
 *
 * Default basePath is `whatsapp://`; deployers may mount under any
 * scheme that satisfies basePath validation (ends with `/`, carries a
 * `://` scheme separator). Mounting under `signed://<pubkey>/whatsapp/`
 * or `acme://services/wa/` is supported — the behaviour layered on top
 * is whatever the outer scheme guarantees.
 */

export const DEFAULT_BASE_PATH = "whatsapp://";

/**
 * Validate a basePath. Throws when the path cannot host a whatsapp
 * surface. Called by `whatsappUris` and the sink factory.
 */
export function validateBasePath(basePath: string): void {
  if (typeof basePath !== "string" || basePath.length === 0) {
    throw new Error(
      "whatsapp: basePath must be a non-empty string",
    );
  }
  if (!basePath.endsWith("/")) {
    throw new Error(
      `whatsapp: basePath must end with '/' (got '${basePath}')`,
    );
  }
  if (!basePath.includes("://")) {
    throw new Error(
      `whatsapp: basePath must contain a scheme separator '://' (got '${basePath}')`,
    );
  }
}

export function messagesUri(basePath: string, to: string): string {
  return `${basePath}messages/${to}`;
}

export function inboundUri(basePath: string, from: string): string {
  return `${basePath}inbound/${from}`;
}

export function statusUri(basePath: string, wamid: string): string {
  return `${basePath}status/${wamid}`;
}

export function messagesPattern(basePath: string): string {
  return `${basePath}messages/**`;
}

export function inboundPattern(basePath: string): string {
  return `${basePath}inbound/**`;
}

export function statusPattern(basePath: string): string {
  return `${basePath}status/**`;
}

/**
 * URI helper bundle. Sinks expose this on `sink.uris`, and apps can
 * also instantiate it standalone for symmetry with the (future)
 * webhook move transport.
 */
export interface WhatsAppUris {
  readonly basePath: string;
  messages(to: string): string;
  inbound(from: string): string;
  status(wamid: string): string;
  readonly messagesPattern: string;
  readonly inboundPattern: string;
  readonly statusPattern: string;
}

export function whatsappUris(
  basePath: string = DEFAULT_BASE_PATH,
): WhatsAppUris {
  validateBasePath(basePath);
  return {
    basePath,
    messages: (to) => messagesUri(basePath, to),
    inbound: (from) => inboundUri(basePath, from),
    status: (wamid) => statusUri(basePath, wamid),
    messagesPattern: messagesPattern(basePath),
    inboundPattern: inboundPattern(basePath),
    statusPattern: statusPattern(basePath),
  };
}
