#!/bin/bash
# Compatibility entry point; use the locked release packages on every platform.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npm run build
