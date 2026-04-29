// HTTP server presenting an OpenAI-compatible surface (`/v1/models`,
// `/v1/chat/completions`) on top of the ChatGPT/Codex Responses backend.
//
// Designed to be the value of Cursor's "Custom OpenAI Base URL" so a coding
// session inside Cursor consumes your Codex/ChatGPT subscription instead of a
// metered OpenAI API key.



import { CodexAuth } from "./auth.ts";
import {
  type LogLevel,
  RequestLogger,
  usageFromCompleted,
  type Usage,
} from "./log.ts";
import { UpstreamClient, UpstreamError } from "./upstream.ts";

// Mirrors the Codex CLI's reasoning effort enum (codex-rs/protocol/openai_models.rs).
// `xhigh` is a Codex-only level above OpenAI's public `high`.
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export type ServerConfig = {
  host: string;
  port: number;
  // Optional shared secret. When set, clients must send
  // `Authorization: Bearer <token>` matching this value (Cursor sends whatever
  // API key you configure into that header).
  apiKey?: string;
  // Reasoning effort applied to every request; overrides the value Cursor
  // sends in `reasoning.effort` so this flag actually does something.
  defaultReasoningEffort: ReasoningEffort;
  // Optional override for the auth.json path; defaults to ~/.codex/auth.json.
  authPath?: string;
  // How chatty per-request logging should be.
  logLevel: LogLevel;
};

// Models the ChatGPT/Codex backend currently accepts via this auth mode.
// Sourced from ~/.codex/models_cache.json on a working codex CLI install.
// Cursor surfaces these in the model picker; you can also type any other slug
// the backend accepts at request time.
const PUBLISHED_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
  "codex-auto-review",
];

export function startServer(config: ServerConfig): ReturnType<typeof Bun.serve> {
  const auth = new CodexAuth(config.authPath);
  const upstream = new UpstreamClient(auth);
  const sessionId = crypto.randomUUID();

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    // Reasoning streams can take a while; let the request idle.
    idleTimeout: 240,
    fetch: (req) => handle(req, { config, upstream, sessionId }),
  });
  return server;
}

type RequestCtx = {
  config: ServerConfig;
  upstream: UpstreamClient;
  sessionId: string;
};

async function handle(req: Request, ctx: RequestCtx): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
  if (url.pathname === "/health" || url.pathname === "/v1/health") {
    return cors(Response.json({ status: "ok" }));
  }
  if (url.pathname === "/v1/models" && req.method === "GET") {
    if (!authorize(req, ctx.config)) return unauthorized();
    return cors(handleListModels());
  }
  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    if (!authorize(req, ctx.config)) return unauthorized();
    return cors(await handleChatCompletions(req, ctx));
  }
  return cors(await handleUnmapped(req));
}

// When Cursor hits an unexpected path (e.g. `/v1/responses`, `/v1/embeddings`,
// `/chat/completions` without `/v1`, etc.) we want loud feedback in the
// terminal so we can fix the proxy instead of debugging blindly.
async function handleUnmapped(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const ctype = req.headers.get("content-type") ?? "";
  let bodyExcerpt = "";
  try {
    const text = await req.text();
    bodyExcerpt = text.length > 800 ? text.slice(0, 800) + "\u2026" : text;
  } catch {}
  process.stderr.write(
    `\x1b[33m[unmapped]\x1b[0m ${req.method} ${url.pathname}${url.search}` +
      `  content-type=${ctype || "-"}\n` +
      (bodyExcerpt ? `           body: ${bodyExcerpt}\n` : ""),
  );
  return Response.json(
    {
      error: {
        message: `not found: ${req.method} ${url.pathname}`,
        type: "not_found",
      },
    },
    { status: 404 },
  );
}

function authorize(req: Request, config: ServerConfig): boolean {
  if (!config.apiKey) return true;
  const header = req.headers.get("authorization");
  if (!header) return false;
  const [scheme, value] = header.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" && value === config.apiKey;
}

function unauthorized(): Response {
  return cors(
    Response.json(
      {
        error: {
          message: "missing or invalid api key",
          type: "authentication_error",
          code: null,
        },
      },
      { status: 401 },
    ),
  );
}

function handleListModels(): Response {
  const created = Math.floor(Date.now() / 1000);
  return Response.json({
    object: "list",
    data: PUBLISHED_MODELS.map((id) => ({
      id,
      object: "model",
      created,
      owned_by: "codex-sub-cursor",
    })),
  });
}

// `/v1/chat/completions` is what Cursor's "Custom OpenAI Base URL" override
// targets. Cursor 1.0+ sends Responses-API-shaped bodies on that path
// (`input`, `instructions`, `reasoning`, ...), so this handler is just a
// thin wrapper that parses the body and routes it through the passthrough.
async function handleChatCompletions(
  req: Request,
  ctx: RequestCtx,
): Promise<Response> {
  const rawBody = await req.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch (err) {
    logIncomingBody("invalid-json", req, rawBody);
    return Response.json(
      {
        error: {
          message: `invalid JSON body: ${(err as Error).message}`,
          type: "invalid_request_error",
        },
      },
      { status: 400 },
    );
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed["input"])) {
    logIncomingBody("unsupported-shape", req, rawBody);
    const presentKeys =
      parsed && typeof parsed === "object"
        ? Object.keys(parsed).join(", ")
        : "(non-object)";
    return Response.json(
      {
        error: {
          message:
            `this proxy only accepts OpenAI Responses-API bodies (with an "input" array). ` +
            `Got keys: [${presentKeys}]. See README "How it works" for the request shape.`,
          type: "invalid_request_error",
        },
      },
      { status: 400 },
    );
  }

  return handleResponsesPassthrough(req, ctx, parsed);
}

// Dumps an incoming request body that the proxy couldn't translate. Useful
// when a new client (Cursor in particular) sends a wire format we don't yet
// handle so the operator can see exactly what arrived.
function logIncomingBody(reason: string, req: Request, body: string): void {
  const url = new URL(req.url);
  const ctype = req.headers.get("content-type") ?? "";
  const ua = req.headers.get("user-agent") ?? "";
  const excerpt = body.length > 1500 ? body.slice(0, 1500) + "\u2026" : body;
  process.stderr.write(
    `\x1b[33m[bad-request:${reason}]\x1b[0m ${req.method} ${url.pathname}` +
      `  content-type=${ctype || "-"}  user-agent=${ua || "-"}\n` +
      `           body: ${excerpt || "(empty)"}\n`,
  );
}

// Wraps an upstream event iterable so we can observe the `response.completed`
// event (which carries token usage and the final finish reason) without
// disturbing the downstream stream forwarded to Cursor.
async function* tapEvents(
  events: AsyncIterable<Record<string, unknown>>,
  onSummary: (usage: Usage | null, finishReason: string | null, serverModel: string | null) => void,
): AsyncIterable<Record<string, unknown>> {
  for await (const event of events) {
    if (event["type"] === "response.completed") {
      const resp = event["response"] as Record<string, unknown> | undefined;
      const usage = usageFromCompleted(resp);
      const status = (resp?.["status"] as string) ?? null;
      const model = (resp?.["model"] as string) ?? null;
      // The Responses API uses `status` rather than `finish_reason`; map the
      // common values onto OpenAI's chat-completions vocabulary.
      const finish = mapStatusToFinishReason(status);
      onSummary(usage, finish, model);
    }
    yield event;
  }
}

function mapStatusToFinishReason(status: string | null): string | null {
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
      return "content_filter";
    default:
      return status;
  }
}

// Fields the Codex backend's Responses API accepts. Anything else (`user`,
// `prompt_cache_retention`, `metadata`, `stream_options`, ...) is silently
// dropped to avoid 400s from the upstream schema validator.
const RESPONSES_ALLOWED_FIELDS = new Set([
  "model",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "store",
  "stream",
  "include",
  "service_tier",
  "prompt_cache_key",
  "text",
  "client_metadata",
]);

// Forwards a Responses-shaped request straight to the Codex backend and pipes
// the SSE stream back to the caller. This is the path Cursor uses.
async function handleResponsesPassthrough(
  req: Request,
  ctx: RequestCtx,
  rawParsed: Record<string, unknown>,
): Promise<Response> {
  const sanitized = sanitizeResponsesRequest(
    rawParsed,
    ctx.sessionId,
    ctx.config.defaultReasoningEffort,
  );
  const wantsStream = sanitized["stream"] === true;

  const logger = new RequestLogger(ctx.config.logLevel, {
    model: typeof sanitized["model"] === "string" ? (sanitized["model"] as string) : "?",
    stream: wantsStream,
    messageCount: Array.isArray(sanitized["input"]) ? (sanitized["input"] as unknown[]).length : 0,
    toolCount: Array.isArray(sanitized["tools"]) ? (sanitized["tools"] as unknown[]).length : 0,
    preview: ctx.config.logLevel === "verbose" ? extractInputPreview(sanitized["input"]) : null,
  });

  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });

  let stream;
  try {
    stream = await ctx.upstream.stream({
      body: { ...sanitized, stream: true },
      signal: abort.signal,
      sessionId: ctx.sessionId,
    });
  } catch (err) {
    if (err instanceof UpstreamError) {
      const { status, body } = err.toOpenAiError();
      logger.complete({
        status,
        upstreamRequestId: err.requestId,
        error: body.error.message,
      });
      return Response.json(body, { status });
    }
    logger.complete({ status: 502, error: (err as Error).message });
    return Response.json(
      { error: { message: (err as Error).message, type: "server_error", code: null } },
      { status: 502 },
    );
  }

  if (!wantsStream) {
    // Cursor always streams; collect anyway and return the final response
    // object so this path remains useful for direct curl testing.
    return handleResponsesNonStreaming(stream, logger);
  }

  let capturedUsage: Usage | null = null;
  let capturedFinishReason: string | null = null;
  let capturedServerModel: string | null = stream.serverModel;

  const sseStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const event of tapEvents(stream.events, (u, finish, model) => {
          capturedUsage = u ?? capturedUsage;
          capturedFinishReason = finish ?? capturedFinishReason;
          capturedServerModel = model ?? capturedServerModel;
        })) {
          if (abort.signal.aborted) break;
          controller.enqueue(encoder.encode(formatResponsesEvent(event)));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        logger.complete({
          status: 200,
          finishReason: capturedFinishReason,
          serverModel: capturedServerModel,
          upstreamRequestId: stream.upstreamRequestId,
          usage: capturedUsage,
        });
      } catch (err) {
        const errorEvent = {
          type: "response.failed",
          response: { error: { message: (err as Error).message } },
        };
        controller.enqueue(encoder.encode(formatResponsesEvent(errorEvent)));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        logger.complete({
          status: 502,
          error: (err as Error).message,
          upstreamRequestId: stream.upstreamRequestId,
        });
      } finally {
        controller.close();
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(sseStream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

async function handleResponsesNonStreaming(
  stream: { events: AsyncIterable<Record<string, unknown>>; upstreamRequestId: string | null; serverModel: string | null },
  logger: RequestLogger,
): Promise<Response> {
  let final: Record<string, unknown> | null = null;
  let usage: Usage | null = null;
  let serverModel: string | null = stream.serverModel;
  try {
    for await (const event of stream.events) {
      if (event["type"] === "response.completed") {
        const resp = event["response"] as Record<string, unknown> | undefined;
        if (resp) final = resp;
        usage = usageFromCompleted(resp) ?? usage;
        if (typeof resp?.["model"] === "string") serverModel = resp["model"] as string;
      }
    }
  } catch (err) {
    logger.complete({
      status: 502,
      error: (err as Error).message,
      upstreamRequestId: stream.upstreamRequestId,
    });
    return Response.json(
      { error: { message: (err as Error).message, type: "server_error", code: null } },
      { status: 502 },
    );
  }
  logger.complete({
    status: 200,
    finishReason: "stop",
    serverModel,
    upstreamRequestId: stream.upstreamRequestId,
    usage,
  });
  return Response.json(final ?? { object: "response" });
}

function sanitizeResponsesRequest(
  raw: Record<string, unknown>,
  sessionId: string,
  effort: ReasoningEffort,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (RESPONSES_ALLOWED_FIELDS.has(key)) out[key] = value;
  }
  // The Codex backend requires the system prompt as a top-level
  // `instructions` string; Cursor packs it into `input` as a
  // `role: "system"` (or `role: "developer"`) item, which the backend
  // rejects with `"Instructions are required"`. Lift any system/developer
  // items out of `input` and concatenate them.
  const lifted = liftSystemInstructions(out["input"], out["instructions"]);
  out["input"] = lifted.input;
  if (lifted.instructions) out["instructions"] = lifted.instructions;
  // The codex backend wants `store: false` for ChatGPT-auth flows; the
  // backend will reject `store: true` with a workspace error.
  out["store"] = false;
  // Default to priority routing (the codex CLI's "fast" service tier maps to
  // this) so Cursor benefits from the same queue the codex CLI does.
  if (typeof out["service_tier"] !== "string") out["service_tier"] = "priority";
  // The Codex Responses endpoint requires a prompt_cache_key for cache hits;
  // mirror the codex CLI by using the per-process session id when Cursor
  // doesn't supply one.
  if (typeof out["prompt_cache_key"] !== "string") out["prompt_cache_key"] = sessionId;
  // Override Cursor's chosen reasoning effort with the value the operator
  // configured. Without this, --reasoning-effort would silently do nothing
  // because Cursor always sets reasoning.effort itself.
  const reasoning = (out["reasoning"] as Record<string, unknown> | undefined) ?? {};
  out["reasoning"] = { ...reasoning, effort };
  return out;
}

// Splits Responses-API `input` items into a leading system prompt
// (concatenated into `instructions`) and the rest (real conversation turns).
// Preserves any pre-existing `instructions` value by appending the lifted
// system text after it.
function liftSystemInstructions(
  input: unknown,
  existingInstructions: unknown,
): { input: unknown[]; instructions: string } {
  const items = Array.isArray(input) ? (input as Record<string, unknown>[]) : [];
  const systemText: string[] = [];
  const remaining: Record<string, unknown>[] = [];
  for (const item of items) {
    const role = item?.["role"];
    const isSystem =
      (item?.["type"] === "message" || item?.["type"] === undefined) &&
      (role === "system" || role === "developer");
    if (isSystem) {
      const text = stringifyResponsesContent(item["content"]);
      if (text) systemText.push(text);
      continue;
    }
    remaining.push(item);
  }
  const baseInstructions =
    typeof existingInstructions === "string" ? existingInstructions : "";
  const combined = [baseInstructions, ...systemText]
    .filter((s) => s && s.trim().length > 0)
    .join("\n\n");
  return { input: remaining, instructions: combined };
}

function stringifyResponsesContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    const p = part as Record<string, unknown>;
    // Both `input_text` and `output_text` carry a plain `text` field.
    if (typeof p?.["text"] === "string") parts.push(p["text"] as string);
  }
  return parts.join("");
}

function formatResponsesEvent(event: Record<string, unknown>): string {
  const type = typeof event["type"] === "string" ? (event["type"] as string) : "";
  const data = JSON.stringify(event);
  return type ? `event: ${type}\ndata: ${data}\n\n` : `data: ${data}\n\n`;
}

function extractInputPreview(input: unknown): string | null {
  if (!Array.isArray(input)) return null;
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i] as Record<string, unknown> | undefined;
    if (!item || item["role"] === "system" || item["type"] !== "message" && item["role"] !== "user") {
      // Fall back to any user item even when shape varies.
      if (item?.["role"] !== "user") continue;
    }
    const content = item["content"];
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      for (const part of content) {
        const p = part as Record<string, unknown>;
        if (typeof p["text"] === "string") text += p["text"] as string;
      }
    }
    text = text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const truncated = text.length > 120 ? text.slice(0, 119) + "\u2026" : text;
    return `${item["role"] ?? "user"}: ${truncated}`;
  }
  return null;
}

function cors(res: Response): Response {
  // Cursor talks to the proxy from the same origin, but allowing CORS makes
  // it trivial to test from a browser too.
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-headers", "*");
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  return new Response(res.body, { status: res.status, headers });
}
