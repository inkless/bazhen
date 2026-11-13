# Reaching Bazhen through Caddy

Caddy runs on the same machine as Bazhen, terminates TLS, and forwards to Bazhen over loopback,
so the only unencrypted hop never leaves the machine and Bazhen keeps listening on `127.0.0.1`
alone. A proxy on another host can't do that: it would reach Bazhen over the network, which
Bazhen refuses to listen on.

Under `pnpm dev` Caddy forwards to the web dev server, `127.0.0.1:7901`, which proxies the API to
the daemon. Caddy passes WebSockets through as they are.

Until device pairing exists, nothing authenticates a request: whatever reaches Caddy can drive
every terminal. Both setups below let in only the devices you name, by address.

## With your own domain

The browser trusts the certificate, with nothing to install on the phone. Caddy gets it from
Let's Encrypt through a DNS challenge, which works for a name that resolves only on your own
network.

1. Point the name at this machine in your local DNS, for example a rewrite of
   `bazhen.example.com` to `192.168.1.20` in AdGuard Home or Pi-hole.
2. Get a Caddy build with your DNS provider's module. For Cloudflare, run
   `caddy add-package github.com/caddy-dns/cloudflare`, or download a build with it from
   caddyserver.com/download. Create an API token that can edit the zone's DNS records.
3. Write a `Caddyfile`, naming the devices that may connect:

   ```caddyfile
   bazhen.example.com {
   	tls {
   		dns cloudflare {env.CF_API_TOKEN}
   	}
   	@others not remote_ip 192.168.1.30 192.168.1.31
   	abort @others
   	reverse_proxy 127.0.0.1:7901
   }
   ```

4. Start Caddy, then start Bazhen with the domain as an external origin:

   ```sh
   CF_API_TOKEN=… caddy run --config Caddyfile
   BAZHEN_EXTERNAL_ORIGINS=https://bazhen.example.com pnpm dev
   ```

## Without a domain

Caddy signs a certificate for this machine's address with its own local authority. Each device
trusts that authority once.

1. Write a `Caddyfile` for the machine's LAN address, and its `.local` name if you want one
   (`scutil --get LocalHostName` prints it on macOS):

   ```caddyfile
   https://192.168.1.20, https://my-mac.local {
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
site. Caddy keeps the key on this machine; don't copy it anywhere else.

## Checking it

`bazhen doctor` lists the external origins the daemon admits. If the page loads but the terminal
says the daemon refused the view, the address in the browser's bar differs from the one in
`BAZHEN_EXTERNAL_ORIGINS`: they must match exactly, scheme and port included.
