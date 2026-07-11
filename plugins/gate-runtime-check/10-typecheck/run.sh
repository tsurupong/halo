#!/usr/bin/env bash
# gate 10-typecheck: 採用 runtime の check.sh へ委譲する薄いラッパー（D5 §2.4）。
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$HERE/../_delegate.sh" "10-typecheck" "check.sh"
