# codex-cursor

Local OpenAI-compatible HTTP proxy that lets Cursor (or anything else that
speaks the OpenAI Chat Completions API) consume your **ChatGPT/Codex
subscription** instead of a metered OpenAI API key.

It reuses the access tokens that the `codex` CLI already stores in
`~/.codex/auth.json`, refreshes them through the same OAuth endpoint Codex
uses, and translates Cursor's `/v1/chat/completions` traffic to the ChatGPT
backend's Responses API at `https://chatgpt.com/backend-api/codex/responses`.

> **Heads up:** This calls a private ChatGPT/Codex backend with the same
> credentials and limits as the `codex` CLI. Treat it like Codex itself:
> personal use only, subject to whatever rate limits and terms come with your
> ChatGPT subscription.

## Prerequisites

1. [`bun`](https://bun.sh) installed (`bun --version` should print >= 1.x).
2. The `codex` CLI installed and signed in (`codex login`). After that
   `~/.codex/auth.json` will exist with a `tokens` object.

## Run it

```bash
# one-shot, no install (pick one):
bunx codex-cursor
npx codex-cursor

# or install globally:
npm i -g codex-cursor
codex-cursor --api-key "$(openssl rand -hex 16)"

# from a clone:
bun install
bun run src/index.ts                            # local-only, no auth
bun run src/index.ts --api-key "$(openssl rand -hex 16)"  # what you actually want for Cursor
```

> `codex-cursor` runs the TypeScript source through [bun](https://bun.sh).
> Both `bunx` and `npx` invocations require `bun` to be installed; the npm
> launcher will exec `bun` from your `PATH`.

Useful flags / env vars:

| Flag                     | Env var                       | Default               |
| ------------------------ | ----------------------------- | --------------------- |
| `--host <addr>`          | `CODEX_SUB_HOST`              | `127.0.0.1`           |
| `--port <n>`             | `CODEX_SUB_PORT`              | `4141`                |
| `--api-key <secret>`     | `CODEX_SUB_API_KEY`           | _no auth required_    |
| `--auth-path <path>`     | `CODEX_SUB_AUTH_PATH`         | `~/.codex/auth.json`  |
| `--reasoning-effort lvl` | `CODEX_SUB_REASONING_EFFORT`  | `xhigh` (one of `minimal`, `low`, `medium`, `high`, `xhigh`) |
| `--quiet` / `--verbose` / `--log-level lvl` | `CODEX_SUB_LOG_LEVEL` | `info` (one of `quiet`, `info`, `verbose`) |

Set `--api-key` to require clients to send `Authorization: Bearer <secret>`.
It's the value Cursor stores as the "API Key". The proxy compares it byte-for-byte;
**you should always set this when exposing the proxy via a tunnel** (see below)
since the public URL is otherwise an open Codex-subscription faucet.

## Expose it to Cursor

Cursor's chat doesn't run in the Cursor app on your laptop — it runs on
Cursor's cloud backend, which then calls your custom OpenAI base URL. Cursor's
backend explicitly refuses private addresses (`127.0.0.1`, `10.x`, `192.168.x`,
Tailscale CGNAT). Pointing Cursor at `http://127.0.0.1:4141/v1` will fail with:

> Provider returned error: Access to private networks is forbidden

Use a [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
to give the local proxy a public HTTPS URL. No signup, no account, just one
command:

```bash
# install once (macOS):
brew install cloudflared

# in terminal A: run the proxy with auth required
bunx codex-cursor --api-key "$(openssl rand -hex 16)"

# in terminal B: tunnel :4141 to a public hostname
cloudflared tunnel --url http://127.0.0.1:4141
```

`cloudflared` prints a URL like `https://random-words.trycloudflare.com`. That
hostname is what Cursor calls.

## Point Cursor at it

1. **Cursor → Settings → Models → "OpenAI API Key" panel**
2. Toggle **Override OpenAI Base URL** and set:
   - **Base URL:** `https://<your-tunnel>.trycloudflare.com/v1` (don't forget
     `/v1`).
   - **API Key:** the hex string you passed to `--api-key`.
3. Click **Verify**. Cursor fetches `/v1/models`; you should see one log line
   in the proxy terminal and Cursor accepting the key.
4. In the model picker, add a custom model. Working slugs at the time of
   writing:

   - `gpt-5.5`
   - `gpt-5.4`
   - `gpt-5.4-mini`
   - `gpt-5.3-codex`
   - `gpt-5.3-codex-spark`

   The exact list is also returned by `GET /v1/models`. Codex's slugs
   change over time; if one fails with `"The '<slug>' model is not supported"`,
   try the next one.

That's it — every Cursor chat completion now flows through the proxy on its
way to the ChatGPT/Codex backend, and you'll see one log line per request.

## How it works

```
```
Cursor  ──/v1/chat/completions──▶  codex-cursor  ──/codex/responses──▶  chatgpt.com backend
                                       │
                                       └─ auth tokens from ~/.codex/auth.json
                                          (refreshed via auth.openai.com/oauth/token)
```

- **Auth.** `src/auth.ts` reads `tokens.access_token` and `tokens.account_id`
  from `~/.codex/auth.json`. On startup and before each request it checks the
  JWT `exp` claim; on expiry (or upstream `401`) it POSTs to
  `https://auth.openai.com/oauth/token` with the same `client_id` the Codex
  CLI uses (`app_EMoamEEZ73f0CkXaXp7hrann`) and writes the refreshed tokens
  back to disk. A running `codex` CLI process and this proxy stay in sync —
  whichever refreshes first updates the file and the other just reloads it.

- **Request shape on `/v1/chat/completions`.** Cursor 1.0+ sends OpenAI
  Responses-API bodies (`input`, `instructions`, `reasoning`, ...) on this
  path even though it's named after Chat Completions. The proxy expects
  exactly that. Anything else (e.g. plain `messages`-shaped Chat Completions)
  is rejected with a 400. The body is sanitized as follows before being
  forwarded:

  - Allow-list `model`, `instructions`, `input`, `tools`, `tool_choice`,
    `parallel_tool_calls`, `reasoning`, `store`, `stream`, `include`,
    `service_tier`, `prompt_cache_key`, `text`, `client_metadata`. Anything
    else Cursor sends (`user`, `prompt_cache_retention`, `metadata`,
    `stream_options`, ...) is dropped \u2014 the Codex backend's schema
    rejects unknown keys.
  - Lift any `role: "system"` or `role: "developer"` items out of `input`
    into the top-level `instructions` string. Codex backend explicitly
    requires `instructions` and returns `"Instructions are required"`
    otherwise.
  - Force `store: false` (the ChatGPT-auth endpoint refuses `store: true`).
  - Default `service_tier: "priority"` so requests land on the same fast
    queue the `codex` CLI uses.
  - **Honor the client's `reasoning.effort`.** Cursor sets it deliberately
    per use case (chat / Tab / composer can want different efforts), so
    we forward whatever it sent. `--reasoning-effort` is used only as a
    fallback when the client doesn't supply one (e.g. raw curl tests).

  The upstream Responses SSE stream is translated back into Chat Completions
  stream chunks, then terminated with `data: [DONE]\n\n`.

- **Headers.** Each upstream request carries the same identity headers the
  Codex CLI sends (`originator: codex_cli_rs`, a matching `User-Agent`,
  `OpenAI-Beta: responses=experimental`, `ChatGPT-Account-ID: <uuid>`,
  `session_id: <uuid>`).

## Logs

Every chat completion produces one line on stdout so you can confirm Cursor is
really hitting the proxy (and not its built-in models):

```text
[14:23:01] gpt-5.5 stream msgs=3 tools=1 → 200 in=14 out=42 (r28) tot=56 1.2s stop req=req_abc
```

Fields: timestamp · requested model (and `→ <served model>` if the backend
rerouted) · `stream` or `json` · message count and tool count · upstream HTTP
status · token usage (`r` = reasoning tokens included in `out`) · wall-clock
duration · finish reason · upstream `x-request-id`.

- `--verbose` prints an extra indented line with the last user message before
  the request runs, so long reasoning streams have something visible up front.
- `--quiet` (or `--log-level quiet`) suppresses per-request logs entirely.


## Smoke test

With the server running (`bun run src/index.ts`):

```bash
curl -s http://127.0.0.1:4141/v1/models | jq

# Cursor sends bodies in this exact shape:
curl -sN http://127.0.0.1:4141/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "gpt-5.5",
    "stream": true,
    "input": [
      {"role": "system", "content": "Be very brief."},
      {"role": "user", "content": "Stream the digits 1 to 5."}
    ],
    "reasoning": {"effort": "low", "summary": "auto"}
  }'
```

## Files

- `src/index.ts`     — CLI entry, flag parsing, server bootstrap.
- `src/server.ts`    — `Bun.serve` HTTP handlers (`/v1/models`,
  `/v1/chat/completions`, `/v1/health`).
- `src/auth.ts`      — `~/.codex/auth.json` loader + OAuth refresh.
- `src/upstream.ts`  — POST to `https://chatgpt.com/backend-api/codex/responses`
  + SSE parser + 401 retry-once.
- `src/log.ts`       \u2014 Per-request stdout logger (timing + tokens).

## Caveats

- Reasoning content (`response.reasoning_*` events) is forwarded as part of
  the verbatim Responses SSE stream. Cursor renders the final answer; the
  reasoning trace is available to clients that want to display it.
- The proxy issues stateless single-turn calls (`store: false`, no
  `previous_response_id`). It does not forward encrypted reasoning items
  between turns; instead Cursor's full message history is sent every time,
  which is how Cursor already wants to operate.
- If the codex CLI invalidates your refresh token (e.g. `codex logout`), the
  proxy will fail with `refresh_token_expired` until you `codex login` again.
