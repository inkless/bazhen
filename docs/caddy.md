# Reaching Bazhen through Caddy

Caddy runs on the same machine as Bazhen, terminates TLS, and forwards to Bazhen over loopback,
so the only unencrypted hop never leaves the machine and Bazhen keeps listening on `127.0.0.1`
alone. A proxy on another host can't do that: it would reach Bazhen over the network, which
Bazhen refuses to listen on.

Under `pnpm dev` Caddy forwards to the web dev server, `127.0.0.1:7901`, which proxies the API to
the daemon. Caddy passes WebSockets through as they are.

## Before you start: what protects it

Until device pairing exists, nothing authenticates a request, and whatever reaches Caddy can
drive every terminal and run any command as you. In the setups below, two lines in the Caddyfile
are the only protection:

- **`bind`** makes Caddy listen on this machine's LAN address only. Without it, Caddy listens on
  ports 80 and 443 of every interface, a VPN's included, and anyone on any of those networks can
  reach it.
- **`remote_ip`** admits only the devices you name, by address. An address names a device only
  while that device holds it: when your phone is away, another device on the network can take its
  address and be let in. So give each phone a fixed address:
  - Turn off its private Wi-Fi address for this network (iOS: Settings → Wi-Fi → ⓘ → Private
    Wi-Fi Address → Off; Android: Wi-Fi → the network → Privacy → Use device MAC), so it keeps
    one hardware address instead of rotating it.
  - Then reserve an address for that hardware address in your router's DHCP settings, and name
    the reserved address in the Caddyfile.

Keep this to a network only you use. The examples use `192.168.1.20` for this machine and
`192.168.1.30` and `192.168.1.31` for the phones; replace them with yours.

## With your own domain

The browser trusts the certificate, with nothing to install on the phone. Caddy gets it from
Let's Encrypt through a DNS challenge, which works for a name that resolves only on your own
network. Every Let's Encrypt certificate is published in the public Certificate Transparency
logs, so the hostname becomes public even though it resolves only at home. Pick one you don't
mind being seen, or get a wildcard certificate (`*.example.com`) so the logs show only the
domain.

1. Point the name at this machine in your local DNS, for example a rewrite of
   `bazhen.example.com` to `192.168.1.20` in AdGuard Home or Pi-hole.
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
   	bind 192.168.1.20
   	tls {
   		dns cloudflare {env.CF_API_TOKEN}
   	}
   	@others not remote_ip 192.168.1.30 192.168.1.31
   	abort @others
   	reverse_proxy 127.0.0.1:7901
   }
   ```

5. Start Caddy, then start Bazhen with the domain as an external origin:

   ```sh
   caddy run --config Caddyfile --envfile ~/.config/caddy/cloudflare.env
   BAZHEN_EXTERNAL_ORIGINS=https://bazhen.example.com pnpm dev
   ```

## Without a domain

Caddy signs a certificate for this machine's address with its own local authority. Each device
trusts that authority once.

1. Write a `Caddyfile` for the machine's LAN address, and its `.local` name if you want one
   (`scutil --get LocalHostName` prints it on macOS):

   ```caddyfile
   https://192.168.1.20, https://my-mac.local {
   	bind 192.168.1.20
   	tls internal
   	@others not remote_ip 192.168.1.30 192.168.1.31
   	abort @others
   	reverse_proxy 127.0.0.1:7901
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
   - **This machine:** run `caddy trust`.
4. Start Caddy and Bazhen with every address you open it at:

   ```sh
   caddy run --config Caddyfile
   BAZHEN_EXTERNAL_ORIGINS=https://192.168.1.20,https://my-mac.local pnpm dev
   ```

The root certificate lets whoever holds its key sign a certificate that device trusts for any
site. Caddy keeps the key on this machine; don't copy it anywhere else. When you no longer reach
Bazhen this way, remove the root from each device: on iOS, delete the profile under Settings →
General → VPN & Device Management; on Android, remove it under Settings → Security → Trusted
credentials → User; on this machine, run `caddy untrust`.

## Checking it

`bazhen doctor` lists the external origins the daemon admits. If the page loads but the terminal
says the daemon refused the view, the address in the browser's bar differs from the one in
`BAZHEN_EXTERNAL_ORIGINS`: they must match exactly, scheme and port included.
