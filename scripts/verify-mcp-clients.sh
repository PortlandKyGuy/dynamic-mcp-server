#!/usr/bin/env bash
set -euo pipefail

# Validate CLI presence/version and basic handshake per model.
# Optional: set EXERCISE_CLI=1 to also invoke the model CLI via executeTask.
#
# Usage: scripts/verify-mcp-clients.sh [claude codex gemini]

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODELS=("$@")
if [ ${#MODELS[@]} -eq 0 ]; then
  MODELS=(claude codex gemini)
fi

EXERCISE_CLI="${EXERCISE_CLI:-0}"
MAIN="src/main.js"

min_version() {
  case "$1" in
    claude) echo "1.0.128" ;;
    codex)  echo "0.73.0" ;;
    gemini) echo "0.21.0" ;;
    *)      echo "0.0.0" ;;
  esac
}

version_ge() {
  # returns 0 if $1 >= $2
  [ "$(printf '%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

for model in "${MODELS[@]}"; do
  echo "=== [$model] ==="
  CLEANUP_FILES=()

  if ! command -v "$model" >/dev/null 2>&1; then
    echo "[skip] $model not installed"
    continue
  fi

  version="$($model --version 2>&1 | head -n1 || true)"
  minver="$(min_version "$model")"
  echo "[info] version: ${version:-unknown} (min $minver)"

  if [ -n "$version" ] && ! version_ge "$version" "$minver"; then
    echo "[fail] $model version below minimum; skipping further checks"
    continue
  fi

  # Create a temp config per model
  CFG="$(mktemp -t mcp-${model}-config.XXXX.json)"
  OUT="$(mktemp -t mcp-${model}-out.XXXX)"
  ERR="$(mktemp -t mcp-${model}-err.XXXX)"
  CLEANUP_FILES+=("$CFG" "$OUT" "$ERR")
  trap 'rm -f "${CLEANUP_FILES[@]}"' EXIT

  cat >"$CFG" <<EOF
{
  "name": "test-${model}-server",
  "model": "${model}",
  "tools": [
    {
      "name": "echo-${model}",
      "description": "echo tool for ${model}",
      "prompt": "echo hello-${model}",
      "inputs": []
    }
  ]
}
EOF

  if ! node "$MAIN" --config "$CFG" --handshake-and-exit >"$OUT" 2>"$ERR"; then
    echo "[fail] handshake exited non-zero (see $OUT / $ERR)"
    continue
  fi

  if grep -qi 'error' "$OUT" "$ERR"; then
    echo "[fail] handshake output contains 'error' (see $OUT / $ERR)"
    continue
  fi

  if ! node -e "JSON.parse(require('fs').readFileSync('$OUT','utf8'))" >/dev/null 2>&1; then
    echo "[fail] handshake stdout not JSON (see $OUT)"
    continue
  fi

  echo "[pass] handshake ok"

  if [ "$EXERCISE_CLI" = "1" ]; then
    if [ "$model" = "gemini" ] && [ "${SKIP_GEMINI_EXERCISE:-1}" = "1" ]; then
      echo "[info] skipping gemini CLI exercise (set SKIP_GEMINI_EXERCISE=0 to force)"
      continue
    fi
    CLI_OUT="$(mktemp -t mcp-${model}-cli-out.XXXX)"
    CLI_ERR="$(mktemp -t mcp-${model}-cli-err.XXXX)"
    CLEANUP_FILES+=("$CLI_OUT" "$CLI_ERR")
    if ! NODE_ENV=test node -e "const { executeTask } = require('./src/main'); (async () => { const res = await executeTask('${model}', undefined, 'Reply with hello-${model} and nothing else.', process.cwd()); console.log(JSON.stringify(res)); process.exit(res.exitCode === 0 ? 0 : 1); })();" >"$CLI_OUT" 2>"$CLI_ERR"; then
      echo "[fail] CLI task failed to execute (see $CLI_OUT / $CLI_ERR)"
      continue
    fi
    if grep -qi 'error' "$CLI_OUT" "$CLI_ERR"; then
      echo "[fail] CLI task output contains 'error' (see $CLI_OUT / $CLI_ERR)"
      continue
    fi
    if ! grep -qi "hello-${model}" "$CLI_OUT"; then
      echo "[fail] CLI task output missing expected text (see $CLI_OUT)"
      continue
    fi
    echo "[pass] CLI task ok"
  else
    echo "[info] CLI task skipped (set EXERCISE_CLI=1 to run)"
  fi
done
