#!/usr/bin/env bash
# `pnpm lint:shell`: shellcheck over every tracked shell script. CI's Ubuntu runners have it
# installed; where it isn't, this fails and names a container that runs the same check.
set -euo pipefail
cd "$(dirname "$0")/.."
mapfile -t files < <(git ls-files '*.sh')
if ! command -v shellcheck >/dev/null 2>&1; then
  echo "shellcheck is not installed. Install it, or run the same check in a container:" >&2
  echo "  docker run --rm -v \"\$PWD:/mnt:ro\" -w /mnt koalaman/shellcheck:stable ${files[*]}" >&2
  exit 1
fi
shellcheck "${files[@]}"
