# Spike: Codex app-server (BZ-31)

Throwaway probes for the foundation design's Codex points C1–C4: thread binding for a
Bazhen-launched TUI, approval fan-out, delivery with a live TUI, and app-server lifetime and
isolation. They import nothing from Bazhen. The findings, with the evidence quoted, live in the
row's notes rather than here.

Run against `codex-cli 0.166.0`. Node 24 runs the `.ts` files directly; there are no
dependencies.

```sh
node c1-binding.ts      # thread/start + inject_items + `codex resume <id> --remote`
node c2-approvals.ts    # TUI + two clients on one thread; who answers, who sees what
node c3-delivery.ts     # turn/start, turn/steer, `codex queue`: idle and mid-turn
node c4-lifetime.ts     # proxy without a server, proxy restarts, pending approvals, two homes
node c4-reconnect.ts    # a --remote TUI when its server restarts
node census.ts          # regenerates schema/ and tallies what runs/ observed
```

Each run writes `runs/<scenario>-<pid>.jsonl` (every JSON-RPC message, plus scenario events)
and pane captures `runs/<scenario>-<pid>.<label>.txt`. Both `runs/` and `schema/` are
gitignored.

## How the sandbox works (`harness.ts`)

- **Codex home.** Each run gets a temporary `CODEX_HOME` with a config pointing at the fake
  provider. `HOME` is left alone: with a temporary `HOME`, macOS raises "keychain not found"
  errors. Credential stores are set to `file` for the same reason.
- **App-server.** It runs as `codex app-server --listen unix://<run dir>/as.sock`, never
  `codex app-server daemon start`, because the managed daemon runs its own auto-update loop.
- **TUIs.** They run as `codex resume <thread id> --remote unix://<sock>` in a private tmux
  server (its own `TMUX_TMPDIR`, `-L bz-spike-*`), driven with `send-keys` and read with
  `capture-pane`.
- **Fake model.** `fake-provider.ts` is a scripted Responses-API server, so turns are
  deterministic and free:
  - `SLOW` streams a reply for ~10 s.
  - `RUN_CMD` asks for an escalated shell command, which raises an approval.
  - Anything else gets an echo.
- **Safety and cleanup.** A run refuses to start above 420 PTYs in use. On exit it kills its
  tmux server, its app-servers, proxies and the provider, then deletes its run directory. Set
  `BZ_KEEP=1` to keep the run directory.

## Protocol notes for whoever writes the adapter

- **The proxy is a byte pipe.** The app-server socket speaks WebSocket, and
  `codex app-server proxy` passes raw bytes through. `rpc-client.ts` does the WebSocket
  handshake and framing over the proxy's stdio.
- **Pause before Enter.** Sending text and Enter to the TUI in one burst reads as a paste, and
  the prompt stays in the composer. The harness waits 0.8 s before Enter.
