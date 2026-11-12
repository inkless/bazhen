---
name: bz-add-daemon-endpoint
description: Adds or changes a Bazhen daemon HTTP endpoint and its protocol message, from the zod schema in packages/protocol to the Hono route in apps/daemon and its tests. Use when changing Bazhen's source in this repository to add, extend or change an API under /v1. Not for operating a running Bazhen through its CLI.
---

# Add a daemon endpoint

**Gate: the protocol change is additive.** Within `/v1`, add optional fields and new messages.
Never rename, remove or tighten anything that has shipped.

## Steps

1. **Schema.** In `packages/protocol/src/index.ts`, add or extend the zod schema and export the
   inferred type. New fields on existing messages are `.optional()`. Bump the minor version of
   `PROTOCOL_VERSION` (`"1.0"` becomes `"1.1"`).
2. **Protocol tests** in `packages/protocol/src/index.test.ts`: one test that a valid message
   parses, and one that a malformed message is rejected.
3. **Route.** In `apps/daemon/src/http/app.ts`, parse the request body with the schema at the
   edge, and parse the response with its schema before returning it. The domain behind the route
   lives in `packages/core`, or behind a seam, not in the handler.
4. **Route tests** in `apps/daemon/src/http/app.test.ts`, through
   `app.request(path, { headers: { host: "127.0.0.1:7900" } })`:
   - the success case;
   - a malformed body;
   - an expected failure, such as a missing terminal.

   The Host allowlist is middleware on every route (`apps/daemon/src/http/app.ts`); keep its
   test.

5. **Client.** If the web client uses the endpoint, import the schema from `@bazhen/protocol`,
   never from the daemon. Then add or extend an e2e test in `tests/e2e/`.
6. Run `pnpm check` (and `pnpm test:real e2e` if step 5 applied). Before pushing, run
   `pnpm test:falsify` and handle the result as in `bz-write-unit-test` step 6.

## Checklist

- [ ] The schema is additive and the minor version is bumped in the same commit.
- [ ] The request and response are both parsed at the daemon's edge.
- [ ] Tests cover success, a malformed request, and the expected failure.
- [ ] `apps/web` imports only `@bazhen/protocol`; lint enforces this.

## Gotchas

- **`packages/core` may import only types from `@bazhen/protocol`.** A value import fails lint.
  Validation happens in the daemon, not the domain.
- **Expected failures are typed errors or discriminated unions** (`docs/standards/code.md`
  § Errors). Map each one to a status code in the route, never by matching the message text.
- **The Host allowlist is a DNS-rebinding defence.** Don't add routes that bypass it.

## Rationalizations

| Thought                                          | Answer                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| "Renaming the field is cleaner"                  | It breaks every client on `/v1`. Add the new field, and deprecate the old one in a comment |
| "Parsing the response is redundant, we built it" | It is what keeps the daemon from shipping a shape the schema doesn't allow                 |
| "The version bump can come later"                | Clients negotiate on it; bump it with the change                                           |
