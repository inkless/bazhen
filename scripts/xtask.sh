#!/bin/sh
# `cargo xtask "$@"`, failing unless xtask itself ran. cargo starts xtask through a runner, and a
# runner set for the host's target triple, in the environment or a cargo config in any parent
# directory, outranks the one the alias names. Such a runner stands in for xtask and can exit 0
# with no gate run, on any host. So this names a file and a nonce, xtask writes the nonce there
# when it ends, and a run that leaves no such receipt fails, whatever it exited.
set -u
receipt=$(mktemp) || exit 1
trap 'rm -f "$receipt"' EXIT
nonce=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
[ -n "$nonce" ] || exit 1
BAZHEN_XTASK_RECEIPT=$receipt BAZHEN_XTASK_NONCE=$nonce cargo xtask "$@"
status=$?
if [ "$(cat "$receipt")" != "$nonce" ]; then
  echo "scripts/xtask.sh: cargo xtask exited $status, but xtask never ran: a target runner stood" \
    "in for it. Unset CARGO_TARGET_<triple>_RUNNER, or move the cargo config that sets it out" \
    "of this repository's parent directories." >&2
  exit 1
fi
exit "$status"
