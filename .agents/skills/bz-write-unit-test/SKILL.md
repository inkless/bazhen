---
name: bz-write-unit-test
description: Writes a small or medium test for Bazhen's own source in this repository (packages/*/src, apps/*/src) and proves it can fail. Use when changing Bazhen's source in this repository, to add behaviour or fix a bug, before writing the implementation. Not for tests against real tmux (bz-write-integration-test), and not for operating a running Bazhen.
---

# Write a unit test for Bazhen's source

**Gate: no new behaviour without a test that fails first, for the right reason.** The commit-msg
hook rejects a test that passes without your change.

## Steps

1. **Pick the size from what the test touches** (`docs/standards/testing.md` § Sizes):
   - memory only: `src/<dir>/<module>.test.ts`;
   - temporary files, SQLite, or the HTTP app: `src/<dir>/<module>.medium.test.ts`.
2. **Name the behaviour, not the function.** For example, "refuses a request whose Host header is
   not on the allowlist".
3. **Copy the nearest exemplar:**
   - plain behaviour: `packages/core/src/terminal.test.ts`;
   - a state table: `packages/core/src/terminal.property.test.ts`, which uses fast-check;
   - HTTP: `apps/daemon/src/http/app.test.ts` (`app.request` with `host: "127.0.0.1:7900"`);
   - SQLite: `apps/daemon/src/store/store.medium.test.ts`.
4. **Run it and watch it fail:** `pnpm test:file <path> -t "<name>"`. It must fail on an
   assertion. A failure to import or compile proves nothing.
5. Implement until it passes, then run `pnpm check`.
6. **Commit.** The hook reruns your new tests against the old source:
   - **SURVIVED** — the test doesn't depend on your change. Fix the assertion.
   - **INVALID** (a brand-new function) — break your code by hand, confirm the test fails on its
     assertion, restore the code, and add a trailer:
     `Control: <what you broke> -> <how the test failed>`.

## Checklist

- [ ] The file name matches the size, and lint is clean.
- [ ] Each test name states one behaviour.
- [ ] I watched it fail on an assertion before the implementation existed, or recorded a control.
- [ ] `pnpm check` passes.

## Gotchas

- **`node:fs`, `node:os`, `node:sqlite` or `node:child_process` in a `*.test.ts` fails lint.**
  Rename the file `*.medium.test.ts`; don't work around the rule.
- **Lint rejects `if`, `&&`, `??` and loops inside a test body.** Split the cases into separate
  tests, or move the logic into a helper at module scope, as the property test does.
- **No mocks of code we own.** Use a fake object built from the real interface, like the
  `runtime` fake in `app.test.ts`. No fake timers: pass time and IDs in.
- **A source file with runtime code needs a sibling test.** `pnpm check` names any that lack one.

## Rationalizations

| Thought                                      | Answer                                                              |
| -------------------------------------------- | ------------------------------------------------------------------- |
| "It's obviously correct, a test is overkill" | Then the test is cheap. The hook decides whether it is load-bearing |
| "I'll write the test after the code"         | Then you never see it fail, so you don't know it can                |
| "I'll `.skip` it for now"                    | Lint fails on `.skip`. Fix it or delete it                          |
| "A mock is quicker"                          | A mock tests your assumptions about the code, not the code          |
| "The falsify hook is wrong here"             | Record a control with a trailer. Never use `--no-verify`            |
