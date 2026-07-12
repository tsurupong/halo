#!/usr/bin/env bash
# gate 30-test: 採用 runtime の test.sh へ委譲する薄いラッパー（D5 §2.4）。
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$HERE/../_delegate.sh" "30-test" "test.sh"
