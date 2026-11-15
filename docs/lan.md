# Opening Bazhen on the LAN

Bazhen can serve HTTPS on your home network itself, so a phone or tablet on the same Wi-Fi opens it
in the browser with no Caddy. It uses a self-signed certificate that the browser trusts once, after
you check the certificate's fingerprint. [docs/caddy.md](caddy.md) is the alternative, with your
own domain or Caddy's local authority.

## Setting it up

1. List the address ranges that may connect. `bazhen doctor` prints this machine's subnets; pick
   your home network's, and add `fe80::/10` if devices reach this machine over IPv6:

   ```toml
   [web]
   listen = "lan" # or BAZHEN_WEB_LISTEN=lan
   lan_allow = ["192.168.1.0/24", "fe80::/10"]
   # lan_port = 7942 (or BAZHEN_LAN_PORT)
   ```

   A device outside these ranges is dropped before it sees anything. Nothing is admitted by
   default: this machine's own subnets include a café's Wi-Fi, a VPN's and Docker's.

2. Build the web app and start Bazhen:

   ```sh
   pnpm build
   pnpm bazhen start
   ```

   The first start under `listen = "lan"` makes the certificate, in `tls/` under Bazhen's state
   directory. It names this machine's `.local` name only, such as `my-mac.local`, and lasts 820
   days; `bazhen doctor` shows when it expires.

3. Run `bazhen pair`. Besides the code, it prints the address to open, such as
   `https://my-mac.local:7942`, and the certificate's SHA-256 fingerprint.

4. On the device, open that address. The browser warns that the certificate isn't trusted. Open
   its details (Safari: Show Details, then view the certificate) and compare the SHA-256 with the
   one `bazhen pair` printed, every pair of characters. Only if they match, choose to visit the
   site.

5. Enter the pairing code.

**If the fingerprints don't match, stop.** Don't trust the certificate and don't pair: something
on the network is standing in for Bazhen, and it would see the code and everything after it.

With `listen = "lan"`, every browser must pair, on this machine's loopback too, as with an
external origin. A browser paired over the LAN stays paired until it goes 30 days unused.

## When the certificate can't be used

If the certificate or its key is damaged, readable by other users, or expired, Bazhen keeps
serving loopback and logs why it isn't serving the LAN; `bazhen doctor` says so too. It never
replaces the certificate by itself, since the fingerprint you checked would change without telling
you. To make a new one, stop Bazhen, delete the `tls` directory the message names, and start it
again. Then trust the new fingerprint on each device as in step 4. Paired devices stay paired.

## What protects it

- Only devices in `lan_allow` reach the listener at all. That isn't authentication: a device that
  takes an address in the range, or a router's port forward, gets past it.
- Pairing is the authentication: the code works once, for 5 minutes, and each device's attempts
  are limited.
- TLS 1.3 only. The certificate can't sign other certificates, so even someone who copies its key
  from this machine can only impersonate Bazhen's `.local` name, nothing else.
- Backups of the state directory carry the key, with the same reach.

Never forward the port to the internet.
