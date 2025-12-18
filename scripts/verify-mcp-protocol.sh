#!/usr/bin/env bash
set -euo pipefail

# Simple MCP handshake verification (CLI-agnostic).
# Usage: scripts/verify-mcp-protocol.sh [config-path]

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONFIG="${1:-__tests__/test-config.json}"
MAIN="src/main.js"

TMP_JSON="$(mktemp -t mcp-handshake.XXXX)"
TMP_ERR="$(mktemp -t mcp-handshake.err.XXXX)"
cleanup() { rm -f "$TMP_JSON" "$TMP_ERR"; }
trap cleanup EXIT

echo "[protocol] using config: $CONFIG"

if [ ! -f "$CONFIG" ]; then
  echo "[protocol] FAIL: config not found: $CONFIG" >&2
  exit 1
fi

if ! node "$MAIN" --config "$CONFIG" --handshake-and-exit >"$TMP_JSON" 2>"$TMP_ERR"; then
  echo "[protocol] FAIL: handshake command exited non-zero" >&2
  cat "$TMP_ERR" >&2
  exit 1
fi

if ! node -e "JSON.parse(require('fs').readFileSync('$TMP_JSON','utf8'))" >/dev/null 2>&1; then
  echo "[protocol] FAIL: stdout not valid JSON (see $TMP_JSON)" >&2
  cat "$TMP_JSON" >&2
  exit 1
fi

if grep -qi 'error' "$TMP_JSON" "$TMP_ERR"; then
  echo "[protocol] FAIL: found 'error' in output" >&2
  echo "--- stdout ---" >&2
  cat "$TMP_JSON" >&2
  echo "--- stderr ---" >&2
  cat "$TMP_ERR" >&2
  exit 1
fi

echo "[protocol] PASS"
