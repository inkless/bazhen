---
name: bz-write-integration-test
description: Writes an integration test in tests/integration that drives Bazhen's tmux runtime against a real private tmux server and real PTYs. Use when changing Bazhen's source in this repository in a way that touches tmux, PTYs, attach and detach, or terminal I/O. Not for in-memory or SQLite tests (bz-write-unit-test), and not for operating a running Bazhen.
---

# Write an integration test against real tmux

**Gate: every tmux server the test starts is named by `testSocket()` and killed in
`afterAll`.** Teardown fails the whole run on any server left alive. A leaked PTY starves every
terminal on the machine, not just Bazhen's.

## Steps

1. Add the test to the right file in `tests/integration/`: runtime behaviour goes in
   `tmux-runtime.test.ts`, and tmux's own behaviour in `tmux-defects.test.ts`. Start a new file
   only for a new area.
2. Get a server with `const socket = testSocket("<label>")`, then add
   `afterAll(() => killServer(socket))`. Helpers are in `tests/integration/helpers.ts`.
3. Build inputs with a builder like `spec()` in `tmux-runtime.test.ts`.
4. **Assert first, wait second.** Use `await expect.poll(() => seen).toContain("…")`, which fails
   with the last value it saw. Never `sleep` to wait for a result, and never a boolean wait helper.
5. If the code opens PTYs, add or extend the lifecycle test: repeat the operation about 30 times
   and `expect.poll(ptyHandleCount).toBeLessThanOrEqual(baseline)`.
6. Run it with `pnpm test:file tests/integration/<file>.test.ts -t "<name>"`, then
   `pnpm test:integration`, then `pnpm check`.
7. On commit, handle the falsify result as in `bz-write-unit-test` step 6.

## Gotchas (each one cost real debugging)

- **Typed input needs `\r`.** Without it, macOS canonical mode stops echoing at the 1024-byte
  line limit, and the probe silently stops answering.
- **Server-wide options live in `TMUX_CONFIG`** (`packages/runtime-tmux/src/index.ts`), which is
  applied before any session exists. `remain-on-exit` is there because a fast-exiting process
  once destroyed its session before a later `set-option` could apply.
- **tmux 3.6b crashes its server** on `window-size manual` set globally (set it per window, after
  creation), and on `refresh-client -A <pane>:off` against a busy pane. A crash kills every
  terminal. The pins are in `tmux-defects.test.ts`.
- **Every runtime tmux call times out after 5 s.** A test that hangs for 30 s is waiting on something
  else.
- **The integration project runs one file at a time**, so don't rely on parallelism.
- If a run hangs, leaks or refuses to start, use `bz-debug-integration-test`.

## Rationalizations

| Thought                                              | Answer                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| "I'll use the default tmux server, it's just a test" | That is the user's real session. Use `testSocket()`              |
| "A `sleep(500)` is fine here"                        | It is either flaky or slow. Use `expect.poll`                    |
| "Cleanup in `afterAll` is noise"                     | Teardown fails the run without it, and the leak outlives the run |
| "The PTY check is overkill for this change"          | A PTY leak exhausted the machine once already                    |
