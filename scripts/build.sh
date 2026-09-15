#!/bin/bash
# Build dsh-session-bridge with the dsh checkout's types.
# Requires DSH_CHECKOUT pointing at a dsh source checkout. tsc emits
# the type-check only; the final JS bundle comes from 'npm run build:client'
# (tsdown), which dev_build_plugin invokes afterwards.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; then
  echo "build: cannot locate the dsh checkout (set DSH_CHECKOUT)" >&2
  exit 1
fi

# The type-check below runs against $DSH_CHECKOUT, which commonly lags the dsh
# that actually loads this plugin — a stale checkout type-checks green while the
# running harness has already moved on. Warn loudly rather than implying support.
read_pkg_version() {
  node -e "try{process.stdout.write(String(require(process.argv[1]).version))}catch(e){process.stdout.write('unknown')}" "$1" 2>/dev/null || echo unknown
}
CHECKOUT_VERSION="$(read_pkg_version "$CHECKOUT/package.json")"
INSTALLED_VERSION="unknown"
GLOBAL_ROOT="$(npm root -g 2>/dev/null | head -n1 || true)"
if [ -n "$GLOBAL_ROOT" ] && [ -f "$GLOBAL_ROOT/@deepseek-ai/dsh/package.json" ]; then
  INSTALLED_VERSION="$(read_pkg_version "$GLOBAL_ROOT/@deepseek-ai/dsh/package.json")"
fi
if [ "$INSTALLED_VERSION" != "unknown" ] && [ "$CHECKOUT_VERSION" != "$INSTALLED_VERSION" ]; then
  echo "build: WARNING — checkout is $CHECKOUT_VERSION but the installed dsh is $INSTALLED_VERSION." >&2
  echo "build: the type-check below therefore does NOT cover the running harness;" >&2
  echo "build: run 'npm run check:compat' to type-check against the installed dsh." >&2
fi

TSC="$CHECKOUT/node_modules/.bin/tsc"
if [ ! -x "$TSC" ]; then
  echo "build: tsc not found at $TSC" >&2
  exit 1
fi

link_pkg() {
  local target="$CHECKOUT/$2"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    exit 1
  fi
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "node_modules/$1" "$target"
}

echo "=== Linking build dependencies (checkout: $CHECKOUT) ==="
mkdir -p node_modules/@deepseek-ai
link_pkg cordis vendor/cordis
link_pkg cosmokit vendor/cosmokit
link_pkg schemastery vendor/schemastery
link_pkg @deepseek-ai/schemastery vendor/schemastery
link_pkg @deepseek-ai/dsh-tools packages/core/tools
link_pkg @deepseek-ai/dsh-agent packages/core/agent
link_pkg @deepseek-ai/dsh-session packages/core/session
link_pkg @deepseek-ai/dsh-session-persistence packages/session/session-persistence
link_pkg @deepseek-ai/dsh-workspace packages/workspace/workspace
link_pkg @deepseek-ai/dsh-home-paths packages/util/home-paths
link_pkg @deepseek-ai/dsh-agent-presets packages/preset/agent-presets
link_pkg @deepseek-ai/dsh-llm packages/llm/llm
link_pkg @deepseek-ai/dsh-util-values packages/util/values
link_pkg @deepseek-ai/dsh-brand packages/util/brand
link_pkg @deepseek-ai/dsh-scope packages/core/scope

echo "=== Type-checking src ==="
"$TSC" -p tsconfig.json --noEmit || {
  echo "build: type-check failed" >&2
  exit 1
}

echo "=== Build complete (JS bundle comes from 'npm run build:client') ==="
