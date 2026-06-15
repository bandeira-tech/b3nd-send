/**
 * Pass-through of Resend's `POST /emails` body. We do not impose a shape
 * on top of theirs — the caller writes whatever Resend accepts. See
 * https://resend.com/docs/api-reference/emails/send-email
 */
export interface ResendEmail {
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  reply_to?: string | string[];
  headers?: Record<string, string>;
  attachments?: Array<{
    filename: string;
    content?: string;
    path?: string;
    content_type?: string;
  }>;
  tags?: Array<{ name: string; value: string }>;
  scheduled_at?: string;
}

export interface ResendSinkConfig {
  apiKey: string;
  /** Override the API base URL — useful for tests against a mock server. */
  baseUrl?: string;
  /** Inject a fetch implementation — useful for tests. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Payload accepted by the sink. The email body is pass-through; we add
 * optional knobs that map onto Resend's HTTP semantics, not onto the
 * email itself.
 */
export interface ResendPayload {
  email: ResendEmail;
  /** Forwarded as the `Idempotency-Key` header. Not auto-generated. */
  idempotencyKey?: string;
}

/** Resend's success response shape from `POST /emails`. */
export interface ResendSendResponse {
  id: string;
}

/** Resend's error response shape — `name`, `message`, `statusCode`. */
export interface ResendErrorResponse {
  name?: string;
  message?: string;
  statusCode?: number;
}
