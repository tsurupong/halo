#!/bin/sh
# ADR-0017 / D11 §3: TypeScript 実装への薄い POSIX sh ランチャー。ロジックは持たない。
HALO_LAUNCHER_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export HALO_LAUNCHER_DIR
exec node "$HALO_LAUNCHER_DIR/../../../packages/plugins/dist/gate-runtime-check/typecheck.js" "$@"
