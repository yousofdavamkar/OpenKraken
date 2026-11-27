#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 3 ]]; then
  echo 'Usage: run-scale-test.sh graph|status|traversal FIXTURE OUTPUT_DIRECTORY' >&2
  exit 2
fi
export GIT_NO_LAZY_FETCH=1
case "$1" in
  graph)
    export OPENKRAKEN_BENCH_REPO="$2"
    suite=benchmark
    profiles=3
    ;;
  status)
    export OPENKRAKEN_STATUS_BENCH_FIXTURE="$2"
    suite=status-benchmark
    profiles=3
    ;;
  traversal)
    export OPENKRAKEN_TRAVERSAL_REPO="$2"
    suite=history-traversal
    profiles=1
    ;;
  *)
    echo "Unknown scale test: $1" >&2
    exit 2
    ;;
esac
runner=(pnpm exec playwright test)
if [[ $(uname -s) == Linux ]]; then runner=(xvfb-run -a "${runner[@]}"); fi
output=$3
mkdir -p "$(dirname "$output")"
"${runner[@]}" "tests/e2e/$suite.test.ts" \
  --repeat-each="$profiles" --workers=1 --reporter=list --output="$output" >"$output.log" 2>&1 || {
    tail -60 "$output.log" >&2
    exit 1
  }
