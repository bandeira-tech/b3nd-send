import {
  type B3ndError,
  ErrorCode,
  type Output,
  type ProtocolInterfaceNode,
  type ReceiveResult,
  type StatusResult,
} from "@bandeira-tech/b3nd-core";
import type {
  ResendErrorResponse,
  ResendPayload,
  ResendSendResponse,
  ResendSinkConfig,
} from "./types.ts";

const DEFAULT_BASE_URL = "https://api.resend.com";
export const URI_EMAILS = "resend://emails";

export function createResendSink(
  config: ResendSinkConfig,
): ProtocolInterfaceNode {
  if (!config.apiKey) {
    throw new Error("createResendSink: apiKey is required");
  }
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  const authHeader = `Bearer ${config.apiKey}`;

  async function sendOne(
    uri: string,
    payload: ResendPayload,
  ): Promise<ReceiveResult> {
    if (uri !== URI_EMAILS) {
      return refusal(ErrorCode.INVALID_URI, uri, `Unknown uri: ${uri}`);
    }
    if (!payload?.email) {
      return refusal(
        ErrorCode.INVALID_SCHEMA,
        uri,
        "Payload missing `email` field",
      );
    }

    const headers: Record<string, string> = {
      "Authorization": authHeader,
      "Content-Type": "application/json",
    };
    if (payload.idempotencyKey) {
      headers["Idempotency-Key"] = payload.idempotencyKey;
    }

    const res = await fetchImpl(`${baseUrl}/emails`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload.email),
    });

    if (res.ok) {
      // Drain the body so the connection can be reused. We don't surface
      // the Resend id through ReceiveResult in v0 — see README.
      await res.json().catch(() => null) as ResendSendResponse | null;
      return { accepted: true };
    }

    const body = await res.json().catch(() => null) as
      | ResendErrorResponse
      | null;
    return refusal(
      mapStatusToCode(res.status),
      uri,
      body?.message ?? `Resend responded ${res.status}`,
      { statusCode: res.status, name: body?.name },
    );
  }

  return {
    receive(msgs: Output[]): Promise<ReceiveResult[]> {
      return Promise.all(
        msgs.map(([uri, payload]) => sendOne(uri, payload as ResendPayload)),
      );
    },

    read<T = unknown>(locators: string[]): Promise<Output<T>[]> {
      return Promise.reject(
        new Error(
          `resend sink has no read surface (locators: ${locators.join(", ")})`,
        ),
      );
    },

    observe(): AsyncIterable<readonly string[]> {
      throw new Error("resend sink has no observe surface");
    },

    status(): Promise<StatusResult> {
      return Promise.resolve({
        status: "healthy",
        message: "resend sink: egress-only, no live healthcheck in v0",
        schema: [URI_EMAILS],
      });
    },
  };
}

function refusal(
  code: ErrorCode,
  uri: string,
  message: string,
  details?: unknown,
): ReceiveResult {
  const errorDetail: B3ndError = { code, message, uri, details };
  return { accepted: false, error: message, errorDetail };
}

function mapStatusToCode(status: number): ErrorCode {
  if (status === 401) return ErrorCode.UNAUTHORIZED;
  if (status === 403) return ErrorCode.FORBIDDEN;
  if (status === 404) return ErrorCode.NOT_FOUND;
  if (status === 409) return ErrorCode.CONFLICT;
  if (status === 422 || status === 400) return ErrorCode.INVALID_SCHEMA;
  return ErrorCode.STORAGE_ERROR;
}
