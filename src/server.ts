// HTTP server presenting an OpenAI-compatible surface (`/v1/models`,
// `/v1/chat/completions`) on top of the ChatGPT/Codex Responses backend.
//
// Designed to be the value of Cursor's "Custom OpenAI Base URL" so a coding
// session inside Cursor consumes your Codex/ChatGPT subscription instead of a
// metered OpenAI API key.

import { CodexAuth } from "./auth.ts";
import { type LogLevel, RequestLogger, usageFromCompleted, type Usage } from "./log.ts";
import { UpstreamClient, UpstreamError, type UpstreamStream } from "./upstream.ts";

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
  // Fallback `reasoning.effort` applied only when the client doesn't supply
  // one. Cursor's own choice wins so chat vs. Tab vs. composer keep their
  // intended efforts.
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
      owned_by: "codex-cursor",
    })),
  });
}

// `/v1/chat/completions` is what Cursor's "Custom OpenAI Base URL" override
// targets. Cursor 1.0+ sends Responses-API-shaped bodies on that path
// (`input`, `instructions`, `reasoning`, ...), so this handler is just a
// thin wrapper that parses the body and routes it through the passthrough.
async function handleChatCompletions(req: Request, ctx: RequestCtx): Promise<Response> {
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
      parsed && typeof parsed === "object" ? Object.keys(parsed).join(", ") : "(non-object)";
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
  let hadToolCall = false;
  for await (const event of events) {
    if (event["type"] === "response.output_item.added") {
      const item = event["item"] as Record<string, unknown> | undefined;
      const t = item?.["type"];
      if (t === "function_call" || t === "custom_tool_call") hadToolCall = true;
    }
    if (event["type"] === "response.completed") {
      const resp = event["response"] as Record<string, unknown> | undefined;
      const usage = usageFromCompleted(resp);
      const model = (resp?.["model"] as string) ?? null;
      // Trust what we actually saw on the wire: if any function_call output
      // item was announced, this turn ends as `tool_calls` regardless of how
      // the upstream `response.status` is reported.
      const finish = hadToolCall ? "tool_calls" : deriveFinishReason(resp);
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

// Like `mapStatusToFinishReason`, but inspects the completed response's
// output for function_call items so chat-completions consumers (Cursor) see
// the canonical `tool_calls` finish reason instead of a generic `stop`.
function deriveFinishReason(resp: Record<string, unknown> | undefined): string | null {
  const status = typeof resp?.["status"] === "string" ? (resp!["status"] as string) : null;
  const output = Array.isArray(resp?.["output"]) ? (resp!["output"] as unknown[]) : [];
  for (const item of output) {
    const it = item as Record<string, unknown> | undefined;
    const t = it?.["type"];
    if (t === "function_call" || t === "custom_tool_call") return "tool_calls";
  }
  return mapStatusToFinishReason(status);
}

// Fields the Codex backend's Responses API accepts. Anything else (`user`,
// `prompt_cache_retention`, `metadata`, `stream_options`, ...) is silently
// dropped to avoid 400s from the upstream schema validator. (Cursor sends
// `prompt_cache_retention` but the Codex Responses backend rejects it with
// `Unsupported parameter`.)
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

// Forwards a Responses-shaped request to the Codex backend, then translates
// the upstream Responses SSE events into Chat Completions chunks for Cursor.
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

  if (ctx.config.logLevel === "verbose") {
    // Full upstream body so failing turns (e.g. model returns `stop` instead
    // of calling an edit tool) can be diffed against working clients like
    // cliproxyapi. One-line JSON keeps it grep-friendly.
    process.stderr.write(
      `\x1b[90m[upstream-body]\x1b[0m ${JSON.stringify({ ...sanitized, stream: true })}\n`,
    );
  }

  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });

  let stream: UpstreamStream;
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
  const chatStreamState: ChatCompletionStreamState = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    model: typeof sanitized["model"] === "string" ? (sanitized["model"] as string) : "?",
    sentRole: false,
    toolCalls: new Map(),
    nextSlot: 0,
    hadToolCall: false,
  };

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
          const formatted = formatChatCompletionEvent(event, chatStreamState);
          if (formatted) controller.enqueue(encoder.encode(formatted));
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
        controller.enqueue(encoder.encode(formatChatCompletionError((err as Error).message)));
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
  stream: {
    events: AsyncIterable<Record<string, unknown>>;
    upstreamRequestId: string | null;
    serverModel: string | null;
  },
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
  // Cursor's "fast mode" appends `-extra` to the model slug (e.g.
  // `gpt-5.5-extra`); the Codex/ChatGPT backend rejects that suffix as an
  // unsupported model. Strip it before forwarding -- the priority service
  // tier we already set below preserves the fast-queue intent.
  if (typeof out["model"] === "string" && (out["model"] as string).endsWith("-extra")) {
    out["model"] = (out["model"] as string).slice(0, -"-extra".length);
  }
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
  // Honor whatever `reasoning.effort` the client sent (Cursor picks it
  // intentionally per use case \u2014 chat vs Tab vs composer can want
  // different efforts). Fall back to the configured default only when the
  // client didn't supply one, so direct curl tests still get a sensible
  // value.
  const reasoning = { ...((out["reasoning"] as Record<string, unknown> | undefined) ?? {}) };
  if (typeof reasoning["effort"] !== "string") reasoning["effort"] = effort;
  out["reasoning"] = reasoning;
  // Match the codex CLI / cliproxyapi: with `store: false` the backend only
  // emits `encrypted_content` on reasoning items when the request opts in via
  // `include`. Cursor preserves reasoning traces across turns (see
  // https://cursor.com/blog/codex-model-harness#preserving-reasoning-traces),
  // and a follow-up turn that ships those items without `encrypted_content`
  // is rejected by the Codex backend \u2014 which manifests as tool-call
  // turns (e.g. edits) failing while single-turn reads succeed.
  const include = Array.isArray(out["include"]) ? [...(out["include"] as unknown[])] : [];
  if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");
  out["include"] = include;
  // Codex CLI / cliproxyapi default: let the model emit multiple tool calls
  // per turn unless the client explicitly opts out.
  if (typeof out["parallel_tool_calls"] !== "boolean") out["parallel_tool_calls"] = true;
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
  const baseInstructions = typeof existingInstructions === "string" ? existingInstructions : "";
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

type ChatCompletionStreamState = {
  id: string;
  created: number;
  model: string;
  sentRole: boolean;
  // Tracks the per-tool-call streaming slot that downstream consumers index
  // chunks by. Keyed by the upstream Responses-API `item.id`.
  toolCalls: Map<string, { slot: number; argsLen: number; callId: string; name: string }>;
  nextSlot: number;
  hadToolCall: boolean;
};

function formatChatCompletionEvent(
  event: Record<string, unknown>,
  state: ChatCompletionStreamState,
): string | null {
  updateChatCompletionState(event, state);

  switch (event["type"]) {
    case "response.created":
      return formatAssistantRoleChunk(state);
    case "response.output_text.delta": {
      const delta = event["delta"];
      if (typeof delta !== "string" || delta.length === 0) return null;
      return (
        formatAssistantRoleChunk(state) + formatChatCompletionChunk(state, { content: delta }, null)
      );
    }
    case "response.output_item.added":
      return formatToolCallStart(event, state);
    case "response.function_call_arguments.delta":
    case "response.custom_tool_call_input.delta":
      return formatToolCallArgsDelta(event, state);
    case "response.output_item.done":
      return formatToolCallDone(event, state);
    case "response.completed": {
      const resp = event["response"] as Record<string, unknown> | undefined;
      const finish = state.hadToolCall ? "tool_calls" : (deriveFinishReason(resp) ?? "stop");
      return formatAssistantRoleChunk(state) + formatChatCompletionChunk(state, {}, finish);
    }
    case "response.failed":
      return formatChatCompletionError(extractResponseError(event));
    default:
      return null;
  }
}

function updateChatCompletionState(
  event: Record<string, unknown>,
  state: ChatCompletionStreamState,
): void {
  const response = event["response"] as Record<string, unknown> | undefined;
  const responseId =
    typeof response?.["id"] === "string"
      ? (response["id"] as string)
      : typeof event["response_id"] === "string"
        ? (event["response_id"] as string)
        : null;
  if (responseId) state.id = responseId;

  if (typeof response?.["model"] === "string") state.model = response["model"] as string;

  const createdAt = response?.["created_at"];
  if (typeof createdAt === "number" && Number.isFinite(createdAt)) {
    state.created = Math.floor(createdAt);
  }
}

function formatAssistantRoleChunk(state: ChatCompletionStreamState): string {
  if (state.sentRole) return "";
  state.sentRole = true;
  return formatChatCompletionChunk(state, { role: "assistant", content: "" }, null);
}

// Translates `response.output_item.added` (function_call variant) into the
// initial chat-completions `tool_calls` chunk that announces a new call,
// including its id and function name with empty arguments.
function formatToolCallStart(
  event: Record<string, unknown>,
  state: ChatCompletionStreamState,
): string | null {
  const item = event["item"] as Record<string, unknown> | undefined;
  // Cursor declares some tools (e.g. `ApplyPatch`) as `type: custom` with a
  // grammar; the upstream emits those as `custom_tool_call` items instead of
  // `function_call`. Both translate to the same chat-completions tool_calls
  // shape \u2014 the only on-the-wire difference is `input` (custom) vs
  // `arguments` (function) for the freeform / JSON payload.
  const itemType = item?.["type"];
  if (!item || (itemType !== "function_call" && itemType !== "custom_tool_call")) return null;
  const itemId = typeof item["id"] === "string" ? (item["id"] as string) : null;
  if (!itemId || state.toolCalls.has(itemId)) return null;
  const slot = state.nextSlot++;
  const callId = typeof item["call_id"] === "string" ? (item["call_id"] as string) : itemId;
  const name = typeof item["name"] === "string" ? (item["name"] as string) : "";
  state.toolCalls.set(itemId, { slot, argsLen: 0, callId, name });
  state.hadToolCall = true;
  return (
    formatAssistantRoleChunk(state) +
    formatChatCompletionChunk(
      state,
      {
        tool_calls: [
          {
            index: slot,
            id: callId,
            type: "function",
            function: { name, arguments: "" },
          },
        ],
      },
      null,
    )
  );
}

// Streams an upstream `response.function_call_arguments.delta` as an
// incremental `tool_calls[i].function.arguments` chunk on the matching slot.
function formatToolCallArgsDelta(
  event: Record<string, unknown>,
  state: ChatCompletionStreamState,
): string | null {
  const delta = event["delta"];
  if (typeof delta !== "string" || delta.length === 0) return null;
  const itemId = typeof event["item_id"] === "string" ? (event["item_id"] as string) : null;
  if (!itemId) return null;
  const tc = state.toolCalls.get(itemId);
  if (!tc) return null;
  tc.argsLen += delta.length;
  return formatChatCompletionChunk(
    state,
    { tool_calls: [{ index: tc.slot, function: { arguments: delta } }] },
    null,
  );
}

// Fallback for backends that don't stream argument deltas: when an
// `response.output_item.done` carries a function_call whose args we never
// forwarded, emit the full arguments string in one chunk.
function formatToolCallDone(
  event: Record<string, unknown>,
  state: ChatCompletionStreamState,
): string | null {
  const item = event["item"] as Record<string, unknown> | undefined;
  const itemType = item?.["type"];
  if (!item || (itemType !== "function_call" && itemType !== "custom_tool_call")) return null;
  const itemId = typeof item["id"] === "string" ? (item["id"] as string) : null;
  if (!itemId) return null;
  const tc = state.toolCalls.get(itemId);
  if (!tc) return null;
  if (tc.argsLen > 0) return null;
  const args = itemType === "custom_tool_call" ? item["input"] : item["arguments"];
  if (typeof args !== "string" || args.length === 0) return null;
  tc.argsLen = args.length;
  return formatChatCompletionChunk(
    state,
    { tool_calls: [{ index: tc.slot, function: { arguments: args } }] },
    null,
  );
}

function formatChatCompletionChunk(
  state: ChatCompletionStreamState,
  delta: Record<string, unknown>,
  finishReason: string | null,
): string {
  return `data: ${JSON.stringify({
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
  })}\n\n`;
}

function formatChatCompletionError(message: string): string {
  return `data: ${JSON.stringify({
    error: {
      message,
      type: "server_error",
      code: null,
    },
  })}\n\n`;
}

function extractResponseError(event: Record<string, unknown>): string {
  const response = event["response"] as Record<string, unknown> | undefined;
  const responseError = response?.["error"] as Record<string, unknown> | undefined;
  if (typeof responseError?.["message"] === "string") {
    return responseError["message"] as string;
  }

  const eventError = event["error"] as Record<string, unknown> | undefined;
  if (typeof eventError?.["message"] === "string") {
    return eventError["message"] as string;
  }

  return "response failed";
}

function extractInputPreview(input: unknown): string | null {
  if (!Array.isArray(input)) return null;
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i] as Record<string, unknown> | undefined;
    if (
      !item ||
      item["role"] === "system" ||
      (item["type"] !== "message" && item["role"] !== "user")
    ) {
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
