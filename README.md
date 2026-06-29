# codex-cursor

Local OpenAI-compatible HTTP proxy that lets Cursor (or anything else that
speaks the OpenAI Chat Completions API) consume your **ChatGPT/Codex
subscription** instead of a metered OpenAI API key.

It reuses the access tokens that the `codex` CLI stores in
`~/.codex/auth.json` and translates Cursor's `/v1/chat/completions` traffic
to the ChatGPT backend's Responses API.

> Calls a private ChatGPT/Codex backend with the same credentials and limits
> as the `codex` CLI. Personal use only.

## Prerequisites

1. [`bun`](https://bun.sh) installed.
2. The `codex` CLI installed and signed in (`codex login`), so
   `~/.codex/auth.json` exists.

## Run it

```bash
# one-shot, no install:
bunx codex-cursor --api-key "$(openssl rand -hex 16)"

# or from a clone:
bun install
bun run src/index.ts --api-key "$(openssl rand -hex 16)"
```

From a clone, the easiest Cursor setup is the localtunnel helper:

```bash
bun install
bun run tunnel
```

That command generates a random API key, starts the proxy from source on
`127.0.0.1:4141`, installs `localtunnel` globally with npm if needed, starts a
public tunnel, and prints the exact values to paste into Cursor:

```text
Cursor OpenAI API Key:  <generated-key>
Cursor OpenAI Base URL: https://example.loca.lt/v1
```

Leave the process running while using Cursor. Press `Ctrl+C` to stop both the
proxy and the tunnel.

Flags / env vars:

| Flag                     | Env var                       | Default               |
| ------------------------ | ----------------------------- | --------------------- |
| `--host <addr>`          | `CODEX_SUB_HOST`              | `127.0.0.1`           |
| `--port <n>`             | `CODEX_SUB_PORT`              | `4141`                |
| `--api-key <secret>`     | `CODEX_SUB_API_KEY`           | _no auth required_    |
| `--auth-path <path>`     | `CODEX_SUB_AUTH_PATH`         | `~/.codex/auth.json`  |
| `--reasoning-effort lvl` | `CODEX_SUB_REASONING_EFFORT`  | `xhigh` (`minimal`, `low`, `medium`, `high`, `xhigh`) |
| `--quiet` / `--verbose` / `--log-level lvl` | `CODEX_SUB_LOG_LEVEL` | `info` (`quiet`, `info`, `verbose`) |

**Always set `--api-key` when exposing the proxy via a tunnel** — the public
URL is otherwise an open Codex-subscription faucet.

## Expose it to Cursor

Cursor's chat runs on Cursor's cloud backend, which calls your custom base
URL. It refuses private addresses, so `http://127.0.0.1:4141/v1` will fail
with `Access to private networks is forbidden`.

From a clone, `bun run tunnel` does this automatically using localtunnel and
prints a `https://...loca.lt/v1` base URL plus the generated API key.

Alternatively, use a [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/):

```bash
brew install cloudflared

# terminal A:
bunx codex-cursor --api-key "$(openssl rand -hex 16)"

# terminal B:
cloudflared tunnel --url http://127.0.0.1:4141
```

`cloudflared` prints a `https://random-words.trycloudflare.com` URL.

## Point Cursor at it

1. **Cursor → Settings → Models → "OpenAI API Key" panel**
2. Toggle **Override OpenAI Base URL** and set:
   - **Base URL:** `https://<your-tunnel>.trycloudflare.com/v1`
   - **API Key:** the hex string you passed to `--api-key`.
3. Click **Verify**.
4. In the model picker, add a custom model. Working slugs:
   `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`.
   The exact list is returned by `GET /v1/models`.

## Caveats

- The proxy issues stateless single-turn calls; Cursor's full history is sent
  every time.
- If `codex logout` invalidates your refresh token, the proxy fails with
  `refresh_token_expired` until you `codex login` again.
