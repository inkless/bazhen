#!/bin/sh
# `cargo xtask "$@"`, with no runner in the way. `cargo xtask` starts xtask through a target runner,
# and a runner set for the host's triple, in the environment or a cargo config in any parent
# directory, outranks the one the alias names: it could stand in for xtask, or start it with
# another root, and pass with no gate run. cargo uses no runner to build. So this builds xtask, as
# the alias would, and runs the binary cargo names itself, naming the repository root it is in.
set -u
root=$(cd -- "$(dirname -- "$0")/.." && pwd -P) || exit 1
# The alias's overrides, so a config's rustc wrapper or compiler doesn't build xtask either, and
# no flags from a config or the environment reach it.
built=$(cd -- "$root" && CARGO_ENCODED_RUSTFLAGS='' cargo build --quiet --locked \
  --package bazhen-xtask --bin bazhen-xtask --message-format=json-render-diagnostics \
  --config "build.rustc-wrapper=''" --config "build.rustc-workspace-wrapper=''" \
  --config "build.rustc='rustc'") || exit 1
# The one executable the build made; a path JSON would escape isn't taken.
bin=$(printf '%s\n' "$built" | sed -n 's/.*"executable":"\([^"\\]*\)".*/\1/p' | tail -n 1)
if [ -z "$bin" ] || [ ! -x "$bin" ]; then
  echo "scripts/xtask.sh: cargo built bazhen-xtask but named no executable this can run." >&2
  exit 1
fi
BAZHEN_XTASK_ROOT=$root
export BAZHEN_XTASK_ROOT
exec "$bin" "$@"
