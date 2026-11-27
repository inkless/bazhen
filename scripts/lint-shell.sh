#!/usr/bin/env bash
# `make lint-shell`: shellcheck over every tracked shell script. CI's Ubuntu runners have it
# installed; where it isn't, this fails and names a container that runs the same check.
set -euo pipefail
cd "$(dirname "$0")/.."
# A read loop, not mapfile: macOS's /bin/bash is 3.2, which has none.
files=()
while IFS= read -r file; do
  files+=("$file")
done < <(git ls-files '*.sh')
if ! command -v shellcheck >/dev/null 2>&1; then
  echo "shellcheck is not installed. Install it, or run the same check in a container:" >&2
  echo "  docker run --rm -v \"\$PWD:/mnt:ro\" -w /mnt koalaman/shellcheck:stable ${files[*]}" >&2
  exit 1
fi
shellcheck "${files[@]}"
