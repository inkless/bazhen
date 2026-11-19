#!/bin/sh
# `cargo xtask "$@"`, exiting as xtask itself did. cargo starts xtask through a runner, and a runner
# set for the host's target triple, in the environment or a cargo config in any parent directory,
# outranks the one the alias names. Such a runner stands in for xtask: it can exit 0 with no gate
# run, start xtask with other arguments, or hide what xtask exited. So this names a file and a
# nonce, xtask writes there the nonce, its exit code and each of its arguments, and this exits with
# that code, failing a run whose receipt is missing or names other arguments.
set -u
receipt=$(mktemp) || exit 1
asked=$(mktemp) || { rm -f "$receipt"; exit 1; }
trap 'rm -f "$receipt" "$asked"' EXIT
nonce=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
[ -n "$nonce" ] || exit 1
# Each argument hex-encoded on a line of its own, as xtask writes them.
for arg in "$@"; do
  printf '%s' "$arg" | od -An -v -tx1 | tr -d ' \n'
  echo
done >"$asked"
BAZHEN_XTASK_RECEIPT=$receipt BAZHEN_XTASK_NONCE=$nonce cargo xtask "$@"
status=$?
if [ "$(sed -n 1p "$receipt")" != "$nonce" ]; then
  echo "scripts/xtask.sh: cargo xtask exited $status, but xtask never ran: a target runner stood" \
    "in for it. Unset CARGO_TARGET_<triple>_RUNNER, or move the cargo config that sets it out" \
    "of this repository's parent directories." >&2
  exit 1
fi
if ! tail -n +3 "$receipt" | cmp -s - "$asked"; then
  echo "scripts/xtask.sh: xtask ran with other arguments than these: a target runner or an" \
    "alias for xtask in the environment changed them. Unset it, or move the cargo config that" \
    "sets it out of this repository's parent directories." >&2
  exit 1
fi
code=$(sed -n 2p "$receipt")
case $code in
'' | *[!0-9]*)
  echo "scripts/xtask.sh: xtask's receipt names no exit code." >&2
  exit 1
  ;;
esac
exit "$code"
