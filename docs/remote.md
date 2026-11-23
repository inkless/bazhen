# Reaching Bazhen from another machine

The daemon listens on IPv4 loopback (`127.0.0.1`) and nowhere else, and it never terminates TLS.
To open it from a laptop or another machine, forward a port to that loopback address over SSH.
When the two machines aren't on one network, reach the daemon host's SSH port through a VPN such as
Tailscale. The forward carries the page and its API, and the daemon needs no extra configuration
for it. Build the web app first (`moon run :build`): the daemon serves whatever was built last, and
answers that it isn't built until then.

`web.listen = "lan"`, `web.lan_port` and `web.lan_allow` are not supported by this daemon: it
refuses to start with any of them.
[docs/lan.md](lan.md) describes the TypeScript daemon's LAN listener, which this daemon doesn't
have. A proxy such as Caddy ([docs/caddy.md](caddy.md)) with external origins is another route; this
page needs neither.

`<daemon-host>` below is the machine the daemon runs on, `<user>` your account there, and `7900`
the daemon's port (`daemon.port`, or `BAZHEN_PORT`). Replace them with yours.

## Forward the port

On the machine you'll browse from:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:7900:127.0.0.1:7900 <user>@<daemon-host>
```

Then open `http://127.0.0.1:7900` in a browser on that machine. Leave the command running: the
forward ends when it does.

Each part matters:

- **The same port on both sides.** The daemon accepts a request only when its Host header is
  `127.0.0.1:<daemon port>` or `localhost:<daemon port>`, as a defence against DNS rebinding. A
  forward from local port 8000 makes the browser send `127.0.0.1:8000`, and the daemon answers
  `host_not_allowed`. If the local port is taken (a daemon of your own on this machine, say), stop
  that or give the remote daemon another port with `BAZHEN_PORT`, so both sides match again.
  `ExitOnForwardFailure=yes` makes `ssh` quit instead of running without the forward.
- **`127.0.0.1` in the forward, and in the address bar.** The daemon listens on IPv4 loopback only,
  so name that address as the forward's target rather than `localhost`, which can mean `::1`. The
  browser's address then is `http://127.0.0.1:7900`, which the daemon already admits, so no
  `web.external_origins` is needed.
- **A local bind of `127.0.0.1`, never `-g`.** `ssh -L` binds loopback unless told otherwise.
  `-g`, a `0.0.0.0` or `*` bind address, and `GatewayPorts yes` in your `ssh_config` all make the
  forwarded port answer on every interface of your machine, so any device on its network reaches
  your daemon. Spelling out `127.0.0.1:7900:` in the option keeps a setting like that from
  widening it.
- **Not `-R`.** A reverse forward from the daemon host, `ssh -R` or `socat`, isn't this route.
  `-L` is the supported one.

## Pairing

An SSH forward carries raw TCP, so the daemon sees no forwarding header, and the connection arrives
at its loopback from `sshd` on the daemon host. Under the default `web.pairing = "auto"` and with no
external origin (setting one makes every browser pair), a browser on the forward counts as this
machine's own and isn't asked to pair. The SSH login is then what stands between the network and
your agents.

Set `web.pairing = "always"` (or `BAZHEN_PAIRING=always`) on the daemon host when:

- **Other users can log in to the daemon host.** Anyone there can reach the daemon's loopback port
  too, and with `auto` the daemon can't tell them from you.
- **Other users can log in to the machine you browse from.** They can reach the forwarded port on
  its loopback.

Then pair the browser once. On the daemon host, run `bazhen devices pair`, and enter the code it
prints on the page at `http://127.0.0.1:7900`. The code works once, for 5 minutes. A browser paired
over plain HTTP, as this is, stays paired while it is used at least once a day. `bazhen devices`
lists paired browsers and `bazhen devices revoke <id>` ends one.

## Tailscale

When the daemon host is on your tailnet, run `ssh` against its tailnet name or address. Allow the
tailnet's devices to reach port 22 of the daemon host and nothing else. The daemon's port needs no
rule at all, since it never leaves the host's loopback, and a rule for it would only invite a
mistake. As an example, to merge into your tailnet policy file, not replace it (adapt it to your
tailnet's tags and groups; the tag has to be applied to the daemon host, for example with
`tailscale up --advertise-tags=tag:bazhen-host`):

```json
{
  "tagOwners": { "tag:bazhen-host": ["autogroup:admin"] },
  "acls": [{ "action": "accept", "src": ["autogroup:member"], "dst": ["tag:bazhen-host:22"] }]
}
```

If the daemon host isn't on the tailnet and a subnet router reaches it, the destination is the
host's address on that subnet, `<daemon-host-address>:22`, and the route to it must be approved.
Don't open the tailnet to more of the host than SSH, and never put the daemon's port on the public
internet, with Tailscale Funnel or otherwise: a paired browser can do anything you can.

## When it doesn't open

| What you see                                        | Why                                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| The daemon answers `host_not_allowed`               | The local port differs from the daemon's, or the address in the bar isn't `127.0.0.1` or `localhost` |
| The browser can't connect, or the connection resets | The forward isn't running, or the daemon isn't (`bazhen status` on the daemon host)                  |
| `ssh` says the address is already in use            | Something on your machine holds that port; see the first point above                                 |
| The page asks to pair                               | `web.pairing = "always"` or an external origin is set: run `bazhen devices pair` on the daemon host  |
