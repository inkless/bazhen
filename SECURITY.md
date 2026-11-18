# Security policy

## Reporting a vulnerability

Report it privately through GitHub:
[Security → Report a vulnerability](https://github.com/inkless/bazhen/security/advisories/new).
Don't open a public issue or pull request for it.

Say what an attacker can do, from where, and how to reproduce it. A report is acknowledged within
7 days, on a best-effort basis. Where a report is confirmed, its fix is published with a GitHub
security advisory, which credits the reporter unless they'd rather not be named.

## Supported versions

Bazhen has no releases yet. Only the latest commit on `main` is supported, and fixes land there.

## Scope

In scope:

- The daemon's HTTP and WebSocket API, on loopback and in LAN mode: pairing, `lan_allow`, TLS
  and paired devices ([docs/lan.md](docs/lan.md)).
- The web client, including escape sequences from a terminal reaching the page.
- The Rust binaries: the `bazhen` CLI, the hook, the holder and the peer.
- Anything that makes Bazhen signal, write to or end a process or tmux server it didn't start.

Out of scope:

- An attacker who already runs code as the same OS user as the daemon, including an agent that
  sets out to evade the checks
  ([What Bazhen knows about who is calling](README.md#what-bazhen-knows-about-who-is-calling)).
  That user is the trust boundary.
- A setup the docs refuse or warn against, such as a `lan_allow` range covering every address,
  or a router port-forward to the LAN listener.
- A bug in tmux, Node.js or a dependency that Bazhen's use of it doesn't expose. Report it
  upstream. If Bazhen does expose it, report it here too.
