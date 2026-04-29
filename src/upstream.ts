// Upstream client for the ChatGPT Codex Responses endpoint.
//
// This module owns:
//   - composing the right headers (auth, originator, account id, beta)
//   - issuing the streaming POST
//   - automatically retrying once after refreshing the access token on 401
//   - parsing the upstream SSE stream into an AsyncIterable of events

import type { CodexAuth } from "./auth.ts";

const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

// Match the codex CLI's identity headers so the backend treats us as a normal
// codex-cli session. Origin/version are copied from the codex-rs source
// (codex-rs/login/src/auth/default_client.rs).
const ORIGINATOR = "codex_cli_rs";
const CODEX_USER_AGENT_VERSION = "0.120.0";

export type UpstreamOptions = {
  body: unknown;
  signal?: AbortSignal;
  sessionId: string;
};

export type UpstreamStream = {
  events: AsyncIterable<Record<string, unknown>>;
  upstreamRequestId: string | null;
  serverModel: string | null;
};

export class UpstreamClient {
  constructor(private readonly auth: CodexAuth) {}

  async stream(opts: UpstreamOptions): Promise<UpstreamStream> {
    let snapshot = await this.auth.refreshIfStale();
    let res = await this.dispatch(opts, snapshot.accessToken, snapshot.accountId);
    if (res.status === 401) {
      // Drain so the connection can be reused.
      await res.body?.cancel().catch(() => {});
      snapshot = await this.auth.forceRefresh();
      res = await this.dispatch(opts, snapshot.accessToken, snapshot.accountId);
    }
    if (!res.ok) {
      const detail = await safeReadText(res);
      throw new UpstreamError(res.status, detail, res.headers.get("x-request-id"));
    }
    const body = res.body;
    if (!body) {
      throw new UpstreamError(502, "upstream returned empty body", null);
    }
    return {
      events: parseSseEvents(body, opts.signal),
      upstreamRequestId: res.headers.get("x-request-id"),
      serverModel: res.headers.get("openai-model"),
    };
  }

  private async dispatch(
    opts: UpstreamOptions,
    accessToken: string,
    accountId: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": accountId,
      "openai-beta": "responses=experimental",
      originator: ORIGINATOR,
      "user-agent": `${ORIGINATOR}/${CODEX_USER_AGENT_VERSION} (codex-sub-cursor)`,
      "session_id": opts.sessionId,
      "x-codex-installation-id": opts.sessionId,
    };
    return fetch(RESPONSES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(opts.body),
      signal: opts.signal,
    });
  }
}

export class UpstreamError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
    public readonly requestId: string | null,
  ) {
    super(`upstream error ${status}: ${detail || "(no body)"}`);
    this.name = "UpstreamError";
  }

  toOpenAiError(): {
    status: number;
    body: { error: { message: string; type: string; code: string | null } };
  } {
    return {
      status: this.status,
      body: {
        error: {
          message: `${this.detail || this.message}${this.requestId ? ` (request id ${this.requestId})` : ""}`,
          type: classifyErrorType(this.status),
          code: null,
        },
      },
    };
  }
}

function classifyErrorType(status: number): string {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return (await res.text()).trim();
  } catch {
    return "";
  }
}

// ---------- SSE parsing ----------

// Yields each `data:` payload as a parsed JSON object. Lines that don't carry
// a JSON payload (e.g. comments, `event:` fields without a body) are dropped.
async function* parseSseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      // SSE separates events with a blank line ("\n\n").
      while ((sep = indexOfDoubleNewline(buffer)) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + (buffer[sep] === "\r" ? 4 : 2));
        const payload = extractDataPayload(rawEvent);
        if (!payload) continue;
        if (payload === "[DONE]") return;
        try {
          yield JSON.parse(payload) as Record<string, unknown>;
        } catch {
          // Ignore malformed events rather than tearing down the whole
          // stream; the upstream occasionally emits keepalives.
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function indexOfDoubleNewline(buf: string): number {
  const lf = buf.indexOf("\n\n");
  const crlf = buf.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function extractDataPayload(rawEvent: string): string {
  const lines = rawEvent.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  return dataLines.join("\n").trim();
}
