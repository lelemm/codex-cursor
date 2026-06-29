#!/usr/bin/env bash
set -Eeuo pipefail

HOST="${CODEX_SUB_HOST:-127.0.0.1}"
PORT="${CODEX_SUB_PORT:-4141}"
API_KEY=""

APP_LOG="$(mktemp -t codex-cursor-app.XXXXXX.log)"
LT_LOG="$(mktemp -t codex-cursor-localtunnel.XXXXXX.log)"
APP_PID=""
LT_PID=""

cleanup() {
  if [[ -n "${LT_PID}" ]] && kill -0 "${LT_PID}" 2>/dev/null; then
    kill "${LT_PID}" 2>/dev/null || true
  fi
  if [[ -n "${APP_PID}" ]] && kill -0 "${APP_PID}" 2>/dev/null; then
    kill "${APP_PID}" 2>/dev/null || true
  fi
  wait "${LT_PID:-}" 2>/dev/null || true
  wait "${APP_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

require_command() {
  local name="$1"
  if ! command -v "${name}" >/dev/null 2>&1; then
    echo "missing required command: ${name}" >&2
    exit 1
  fi
}

require_command openssl
require_command bun
require_command npm

API_KEY="$(openssl rand -hex 16)"

echo "Installing localtunnel..."
npm install -g localtunnel
require_command lt

echo "Starting codex-cursor on http://${HOST}:${PORT}..."
bun run src/index.ts \
  --host "${HOST}" \
  --port "${PORT}" \
  --api-key "${API_KEY}" \
  >"${APP_LOG}" 2>&1 &
APP_PID="$!"

APP_READY=0
for _ in {1..100}; do
  if ! kill -0 "${APP_PID}" 2>/dev/null; then
    echo "codex-cursor exited before becoming ready:" >&2
    cat "${APP_LOG}" >&2
    exit 1
  fi

  if bun -e "fetch('http://${HOST}:${PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    APP_READY=1
    break
  fi
  sleep 0.2
done

if [[ "${APP_READY}" != "1" ]]; then
  echo "Timed out waiting for codex-cursor to answer /health:" >&2
  cat "${APP_LOG}" >&2
  exit 1
fi

echo "Starting localtunnel..."
lt --port "${PORT}" --local-host "${HOST}" >"${LT_LOG}" 2>&1 &
LT_PID="$!"

TUNNEL_URL=""
for _ in {1..120}; do
  if ! kill -0 "${LT_PID}" 2>/dev/null; then
    echo "localtunnel exited before printing a URL:" >&2
    cat "${LT_LOG}" >&2
    exit 1
  fi

  TUNNEL_URL="$(sed -nE 's/.*(https:\/\/[^[:space:]]+\.loca\.lt).*/\1/p' "${LT_LOG}" | tail -n 1)"
  if [[ -n "${TUNNEL_URL}" ]]; then
    break
  fi
  sleep 0.5
done

if [[ -z "${TUNNEL_URL}" ]]; then
  echo "Timed out waiting for localtunnel URL:" >&2
  cat "${LT_LOG}" >&2
  exit 1
fi

echo
echo "Cursor OpenAI API Key:  ${API_KEY}"
echo "Cursor OpenAI Base URL: ${TUNNEL_URL}/v1"
echo
echo "Local proxy: http://${HOST}:${PORT}/v1"
echo "Press Ctrl+C to stop codex-cursor and localtunnel."

set +e
wait -n "${APP_PID}" "${LT_PID}"
STATUS="$?"
set -e

echo
echo "A background process exited. Logs:"
echo "  codex-cursor: ${APP_LOG}"
echo "  localtunnel:  ${LT_LOG}"
exit "${STATUS}"
