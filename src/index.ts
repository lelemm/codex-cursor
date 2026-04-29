#!/usr/bin/env bun
// Entry point. Parses CLI flags / env vars and starts the proxy.

import { startServer, type ReasoningEffort, type ServerConfig } from "./server.ts";
import type { LogLevel } from "./log.ts";

const REASONING_EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];

function parseArgs(argv: string[]): ServerConfig {
  const env = process.env;
  let port = parseIntOr(env["CODEX_SUB_PORT"], 4141);
  let host = env["CODEX_SUB_HOST"] ?? "127.0.0.1";
  let apiKey = env["CODEX_SUB_API_KEY"];
  let authPath = env["CODEX_SUB_AUTH_PATH"];
  let defaultReasoningEffort: ReasoningEffort = parseEffort(
    env["CODEX_SUB_REASONING_EFFORT"],
    "xhigh",
  );
  let logLevel: LogLevel = parseLogLevel(env["CODEX_SUB_LOG_LEVEL"], "info");

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      // fallthrough not reached; switch above exits.
      // eslint-disable-next-line no-fallthrough
      case "--port":
        port = parseIntOr(argv[++i], port);
        break;
      case "--host":
        host = argv[++i] ?? host;
        break;
      case "--api-key":
        apiKey = argv[++i];
        break;
      case "--auth-path":
        authPath = argv[++i];
        break;
      case "--reasoning-effort":
        defaultReasoningEffort = parseEffort(argv[++i], defaultReasoningEffort);
        break;
      case "--quiet":
        logLevel = "quiet";
        break;
      case "--verbose":
        logLevel = "verbose";
        break;
      case "--log-level":
        logLevel = parseLogLevel(argv[++i], logLevel);
        break;
      default:
        if (arg && arg.startsWith("--")) {
          console.error(`unknown flag: ${arg}`);
          process.exit(2);
        }
    }
  }

  return { host, port, apiKey, authPath, defaultReasoningEffort, logLevel };
}

function parseIntOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseEffort(value: string | undefined, fallback: ReasoningEffort): ReasoningEffort {
  if (!value) return fallback;
  if ((REASONING_EFFORTS as string[]).includes(value)) {
    return value as ReasoningEffort;
  }
  console.error(
    `invalid reasoning effort '${value}'; must be one of ${REASONING_EFFORTS.join(", ")}`,
  );
  process.exit(2);
}

const LOG_LEVELS: LogLevel[] = ["quiet", "info", "verbose"];
function parseLogLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  if (!value) return fallback;
  if ((LOG_LEVELS as string[]).includes(value)) {
    return value as LogLevel;
  }
  console.error(
    `invalid log level '${value}'; must be one of ${LOG_LEVELS.join(", ")}`,
  );
  process.exit(2);
}

function printHelp(): void {
  process.stdout.write(`codex-sub-cursor — OpenAI-compatible proxy backed by your Codex/ChatGPT subscription

Usage:
  bun run src/index.ts [flags]

Flags:
  --host <addr>             Bind address (default: 127.0.0.1, env CODEX_SUB_HOST)
  --port <n>                Port (default: 4141, env CODEX_SUB_PORT)
  --api-key <secret>        Require this bearer token from clients (env CODEX_SUB_API_KEY)
  --auth-path <path>        Path to codex auth.json (default: ~/.codex/auth.json)
  --reasoning-effort <lvl>  minimal|low|medium|high|xhigh (default: xhigh)
  --quiet                   Suppress per-request logs (env CODEX_SUB_LOG_LEVEL=quiet)
  --verbose                 Log a preview of each request's last user message
  --log-level <lvl>         quiet|info|verbose (default: info)
  -h, --help                Show this help

Cursor setup:
  Settings → Models → "OpenAI API Key" panel
    Override API Key:    <whatever you like, or the value of --api-key>
    Override Base URL:   http://127.0.0.1:<port>/v1
  Then add a custom model name like "gpt-5-codex" or "gpt-5.5".
`);
}

const config = parseArgs(process.argv.slice(2));
const server = startServer(config);
console.log(
  `codex-sub-cursor listening on http://${config.host}:${server.port}\n` +
    `  base URL for Cursor: http://${config.host}:${server.port}/v1\n` +
    `  auth required:       ${config.apiKey ? "yes" : "no"}\n` +
    `  reasoning effort:    ${config.defaultReasoningEffort} (overrides client-supplied)\n` +
    `  log level:           ${config.logLevel}\n` +
    `  cursor needs a public URL \u2014 expose this with:\n` +
    `    cloudflared tunnel --url http://${config.host}:${server.port}`,
);

const shutdown = () => {
  console.log("\nshutting down");
  server.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
