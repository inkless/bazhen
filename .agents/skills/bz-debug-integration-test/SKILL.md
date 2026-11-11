---
name: bz-debug-integration-test
description: Diagnoses Bazhen integration test runs that hang, report leaked tmux servers ("Tests left N tmux server(s) running"), refuse to start ("Refusing to run: N PTYs are in use"), or fail intermittently. Use when pnpm test:integration or pnpm check misbehaves while changing Bazhen's source in this repository. Not for operating a running Bazhen.
---

# Debug an integration test run

**Gate: find the leak or the race. Never raise the PTY cutoff, add retries, or add sleeps to make
a run pass.**

## "Refusing to run: N PTYs are in use machine-wide"

Something on this machine holds PTYs. macOS allows 511 in total, and the cutoff is 420.

1. Count them with `ls /dev/ttys* | wc -l`, and find the holders with
   `lsof /dev/ptmx 2>/dev/null | awk 'NR>1 {print $1, $2}' | sort | uniq -c | sort -rn | head`.
2. If the holder is a Node process from an earlier test run, kill that process. If it's
   something of the user's (terminals, editors), stop and tell the user. Don't kill it.
3. A Bazhen daemon that holds one PTY per attach and never releases them is a leak. Reproduce it
   with the lifecycle test in `tests/integration/tmux-runtime.test.ts`.

## "Tests left N tmux server(s) running"

Teardown found servers from this run alive, and has already killed them. The message names them.

1. The label in `bz-test-<run>-<label>` tells you which test started each one. A server named
   `default` means a test ran `tmux` without `-L`: give it a `testSocket()`.
2. That test is missing `afterAll(() => killServer(socket))`, or it created a second socket it
   never recorded. Fix the test. Teardown is a backstop, not the cleanup.

## The run hangs

1. Run one file at a time, and find which tests never finish:
   `pnpm test:file tests/integration/<file>.test.ts --reporter=verbose`
2. For handles that keep the process alive, add `--reporter=hanging-process`.
3. Usual causes:
   - a `stream` never `close()`d after `attach()`;
   - a probe typed without `\r`, so canonical mode stopped echoing;
   - a `waitFor` loop instead of `expect.poll`.

   Every tmux call already times out after 5 s, so a hang is in our code or the test.

## It fails sometimes

1. Rerun only that test, about 20 times:
   `for i in $(seq 20); do pnpm test:file <file> -t "<name>" || break; done`
2. Usual causes:
   - an option set after `new-session` that had to apply before it: move it into `TMUX_CONFIG`;
   - asserting before the output arrived: use `expect.poll`;
   - two runs sharing a fixed name or port: use `testSocket()` and free ports.
3. Fix the race. There are no retries in this repository.

## Known tmux 3.6b server crashes (a crash kills every terminal)

- `set -g window-size manual`: set it per window, after creation.
- `refresh-client -A <pane>:off` against a pane that is producing output.

The pins are in `tests/integration/tmux-defects.test.ts`. If a pin starts failing after a tmux
upgrade, the defect is fixed upstream; say so in the commit rather than deleting the pin.

## Inspecting a server

Each test run keeps its tmux servers in a private directory, `/tmp/bz-tmux-*/tmux-<uid>/`, which
teardown deletes. While a run is hung, list its servers with `ls /tmp/bz-tmux-*/tmux-$(id -u)/`.
Inspect one with `TMUX_TMPDIR=<that bz-tmux dir> tmux -L <socket> list-sessions`, and kill it the
same way with `kill-server`. Always set `TMUX_TMPDIR` and `-L`: you are running inside the
user's own tmux server, and a bare `tmux kill-server` would end every session on it.
