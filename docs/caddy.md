# Reaching Bazhen through Caddy

Caddy runs on the same machine as Bazhen, terminates TLS, and forwards to Bazhen over loopback,
so the only unencrypted hop never leaves the machine and Bazhen keeps listening on `127.0.0.1`
alone. A proxy on another host can't do that: it would reach Bazhen over the network, which
Bazhen refuses to listen on.

Caddy forwards to the daemon, `127.0.0.1:7900`, which serves the built web app and the API on
one origin. Build the app first (`pnpm build`), and again after you pull: the daemon serves
whatever was built last, from the next page load on. Caddy passes WebSockets through as they
are, and says in `X-Forwarded-For` which device each request came from. The daemon asks every
such request to pair, even if it was started without the external origin. Only a proxy that
says where a request came from is noticed this way: a forwarder that adds no header, such as
`ssh -R` or `socat`, needs `web.pairing = "always"`.

Never point Caddy, or any other forwarder, at the web dev server (`pnpm dev`, port 7901). It
serves the repository's source, `/@fs/` paths included. It refuses a request with a Host other
than loopback's, another page's Origin, or a proxy's forwarding header (`X-Forwarded-For`,
`Forwarded`, `Via`, `X-Real-IP`, `X-Forwarded-Host`, `X-Forwarded-Proto`), but it can't tell a
forwarder that presents a loopback Host and adds none of them, such as `socat`, `ssh -R`, or a
proxy set to rewrite Host, from this machine's own browser.

## Before you start: what protects it

With an external origin configured, every browser must pair (`bazhen pair`) before it reaches
the API, but a paired phone can do anything you can, and the pairing form itself is open to
whoever reaches Caddy. The page itself loads unpaired, since it shows the pairing form: it is the
same built bundle for everyone and holds nothing secret. Two lines in the Caddyfile below decide
who reaches it:

```caddyfile
@outside not remote_ip 192.168.1.0/24
abort @outside
```

- **Your address range only.** Caddy listens on ports 80 and 443 of every interface, a VPN's
  included. `remote_ip` aborts every request whose source address is outside the range, before it
  reaches Bazhen. It checks the address, not the network the request came in on, so it admits
  every device on your home network to the pairing form, guests' and appliances' included; pairing
  still gates everything past it. It also admits any other network that uses the same range:
  `192.168.1.0/24` is the commonest default, so a café's or hotel's Wi-Fi, or a VPN whose peers
  fall in it, gets through while this machine is there with Caddy running. Stop Caddy when you take
  the machine away from home, or narrow it with one of the next two.
- **Your devices only.** Name the phones in `remote_ip` instead of the range
  (`not remote_ip 192.168.1.30 192.168.1.31`), and only they reach the pairing form. An address
  names a device only while that device holds it: when your phone is away, another device on the
  network can take its address and be let in. So give each phone a fixed address:
  - Turn off its private Wi-Fi address for this network (iOS: Settings → Wi-Fi → ⓘ → Private
    Wi-Fi Address → Off; Android: Wi-Fi → the network → Privacy → Use device MAC), so it keeps
    one hardware address instead of rotating it.
  - Then reserve an address for that hardware address in your router's DHCP settings, and name
    the reserved address in the Caddyfile.
- **Your LAN address only.** Caddy's `bind` listens on this machine's LAN address alone, so no
  other interface, a VPN's included, reaches it. On macOS 10.14 and later, a process that isn't
  root can listen on a port below 1024 only on all addresses at once, so `bind` on port 443 needs
  `sudo`, which breaks Caddy's later runs as you (see
  [Running it as yourself](#running-it-as-yourself)). Use `bind` on a port above 1024 instead
  ([On a high port](#on-a-high-port)).

`remote_ip` acts only after the TLS handshake, so whoever can reach the port still sees the
certificate, and with it the hostname.

Keep this to a network only you use. The examples use `192.168.1.0/24` for the network,
`192.168.1.20` for this machine and `192.168.1.30` and `192.168.1.31` for the phones; replace them
with yours.

A Mac on Wi-Fi and a dock's Ethernet at once has an address on each. Use the one on the default
route, everywhere this page names this machine's address:

```sh
ipconfig getifaddr "$(route -n get default | awk '/interface:/ { print $2 }')"
```

Run it with any VPN off: a full-tunnel VPN takes the default route, and the command then prints
the VPN's address, or nothing. Check that the address it prints is in your home network's range.

## With your own domain

The browser trusts the certificate, with nothing to install on the phone. Caddy gets it from
Let's Encrypt through a DNS challenge, which works for a name that resolves only on your own
network. Every Let's Encrypt certificate is published in the public Certificate Transparency
logs, so the hostname becomes public even though it resolves only at home. Pick one you don't
mind being seen, or get a wildcard certificate (`*.example.com`) so the logs show only the
domain.

1. Point the name at this machine in your local DNS, for example a rewrite of
   `bazhen.example.com` to `192.168.1.20` in AdGuard Home or Pi-hole. Give it no IPv6 (AAAA)
   record, or add that network's IPv6 prefix to `remote_ip`: Caddy listens on IPv6 too, and a
   phone that connects over IPv6 is aborted by the IPv4 range.
2. Get a Caddy build with your DNS provider's module. For Cloudflare, run
   `caddy add-package github.com/caddy-dns/cloudflare`, or download a build with it from
   caddyserver.com/download.
3. Create an API token limited to Zone → DNS → Edit on this one zone, and keep it in a file only
   you can read, outside any git repository, rather than on the command line, where it would land
   in your shell history:

   ```sh
   mkdir -p ~/.config/caddy
   (umask 077 && printf 'CF_API_TOKEN=%s\n' "$(pbpaste)" > ~/.config/caddy/cloudflare.env)
   ```

   (`pbpaste` reads the token you copied, on macOS; the file is created with mode 0600.)

4. Write a `Caddyfile`:

   ```caddyfile
   bazhen.example.com {
   	tls {
   		dns cloudflare {env.CF_API_TOKEN}
   	}
   	@outside not remote_ip 192.168.1.0/24
   	abort @outside
   	reverse_proxy 127.0.0.1:7900
   }
   ```

5. Start Caddy, then start Bazhen with the domain as an external origin:

   ```sh
   caddy run --config Caddyfile --envfile ~/.config/caddy/cloudflare.env
   pnpm build
   BAZHEN_EXTERNAL_ORIGINS=https://bazhen.example.com pnpm bazhen start
   ```

## Without a domain

Caddy signs a certificate for this machine's address with its own local authority. Each device
trusts that authority once.

1. Write a `Caddyfile` for the machine's LAN address, and its `.local` name if you want one
   (`scutil --get LocalHostName` prints it on macOS). `skip_install_trust` keeps Caddy from adding
   its authority to this machine's trust store, which the phone doesn't need, and which would ask
   for your password. A phone may resolve the `.local` name to this machine's IPv6 address, connect
   over IPv6 and be aborted by the IPv4 range, so open the IPv4 address, or add the LAN's IPv6
   prefixes (`fe80::/10` and its own `/64`) to `remote_ip`:

   ```caddyfile
   {
   	skip_install_trust
   }

   https://192.168.1.20, https://my-mac.local {
   	tls internal
   	@outside not remote_ip 192.168.1.0/24
   	abort @outside
   	reverse_proxy 127.0.0.1:7900
   }
   ```

2. Run `caddy run --config Caddyfile` once, and stop it. That creates the authority, whose root
   certificate is at `~/Library/Application Support/Caddy/pki/authorities/local/root.crt` on macOS
   and `~/.local/share/caddy/pki/authorities/local/root.crt` on Linux.
3. Trust that root certificate on each device. Send the file to the device, then:
   - **iOS:** open it to install the profile (Settings → General → VPN & Device Management), then
     turn on full trust under Settings → General → About → Certificate Trust Settings.
   - **Android:** Settings → Security → More security settings → Install a certificate → CA
     certificate. The menu names vary by maker.
   - **This machine:** run `caddy trust`, only if you also open Bazhen this way here.
4. Start Caddy and Bazhen with every address you open it at:

   ```sh
   caddy run --config Caddyfile
   pnpm build
   BAZHEN_EXTERNAL_ORIGINS=https://192.168.1.20,https://my-mac.local pnpm bazhen start
   ```

The root certificate lets whoever holds its key sign a certificate that device trusts for any
site. Caddy keeps the key on this machine; don't copy it anywhere else. When you no longer reach
Bazhen this way, remove the root from each device: on iOS, delete the profile under Settings →
General → VPN & Device Management; on Android, remove it under Settings → Security → Trusted
credentials → User; on this machine, if you ran `caddy trust`, run `caddy untrust`.

## On a high port

`bind` works without root on a port above 1024. Give the port in each site address, and in
`BAZHEN_EXTERNAL_ORIGINS`, since the browser shows it:

```caddyfile
{
	skip_install_trust
	auto_https disable_redirects
}

https://192.168.1.20:8443 {
	bind 192.168.1.20
	tls internal
	@outside not remote_ip 192.168.1.0/24
	abort @outside
	reverse_proxy 127.0.0.1:7900
}
```

```sh
BAZHEN_EXTERNAL_ORIGINS=https://192.168.1.20:8443 pnpm bazhen start
```

Caddy would otherwise also listen on port 80 to redirect plain HTTP, on the bound address, which
needs root as port 443 does; `disable_redirects` keeps it off port 80. Keep the `remote_ip` lines:
`bind` leaves out the other interfaces, not the other devices on this one. Trust the authority on
each device as in steps 2 and 3 of [Without a domain](#without-a-domain). With your own domain,
use `bazhen.example.com:8443` and its `tls` block instead, and leave out `skip_install_trust`.

## Running it as yourself

Run Caddy as your user, never with `sudo`. `sudo` keeps your `HOME`, so Caddy writes its
certificates and authority under `~/Library/Application Support/Caddy` as root, and the next run
as yourself fails with "permission denied". If that happened, give the directory back:

```sh
sudo chown -R "$(whoami)" ~/Library/Application\ Support/Caddy
```

## Checking it

`bazhen doctor` lists the external origins the daemon admits, and where it serves the web app
from; a page that says the app isn't built needs `pnpm build`. If the page loads but the terminal
says the daemon refused the view, the address in the browser's bar differs from the one in
`BAZHEN_EXTERNAL_ORIGINS`: they must match exactly, scheme and port included.
