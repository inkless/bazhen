# Opening Bazhen on the LAN

> This page applies to the TypeScript daemon only. The Rust daemon serves loopback only; to reach
> it from another machine, see [docs/remote.md](remote.md).

Bazhen can serve HTTPS on your home network itself, so a phone or tablet on the same Wi-Fi opens it
in the browser with no Caddy. It uses a self-signed certificate that the browser trusts once, after
you check the certificate's fingerprint. [docs/caddy.md](caddy.md) is the alternative, with your
own domain or Caddy's local authority.

## Setting it up

1. List the address ranges that may connect. Bazhen refuses to start under `listen = "lan"`
   without them, and its message lists this machine's subnets, as `bazhen doctor` does. Pick your
   home network's, and its IPv6 network too if it has one, since phones often reach `.local` over
   IPv6:

   ```toml
   [web]
   listen = "lan" # or BAZHEN_WEB_LISTEN=lan
   lan_allow = ["192.168.1.0/24", "fdeb:9f4b:2183:4c5b::/64"]
   # lan_port = 7942 (or BAZHEN_LAN_PORT)
   ```

   A device outside these ranges is dropped before it sees anything. Nothing is admitted by
   default: this machine's own subnets include a café's Wi-Fi, a VPN's and Docker's. A range that
   admits every address (`0.0.0.0/0`, `::/0`) is refused; that catches a typo, not a choice, since
   two halves (`0.0.0.0/1` and `128.0.0.0/1`) still cover everything. The narrower the better: a
   guest on your network can use up a pairing code's wrong guesses, so if your devices have fixed
   addresses, list just those (`192.168.1.30/32`), or the smallest range that holds them.
   Link-local addresses (`fe80::`) are the same on every network, so a link-local range names its
   interface, such as `fe80::/10%en0`, and admits only devices on that one.

2. Let the port through this machine's firewall, if it has one, for the same ranges. On Linux
   with `ufw`:

   ```sh
   sudo ufw allow from 192.168.1.0/24 to any port 7942 proto tcp
   ```

   On macOS, allow incoming connections for `node` when the firewall asks. A device whose page
   times out without a warning is usually stopped here.

3. Build the web app and start Bazhen:

   ```sh
   moon run :build
   moon run :bazhen -- start
   ```

   The first start under `listen = "lan"` makes the certificate, in `tls/` under Bazhen's state
   directory. It names this machine's `.local` name only, such as `my-mac.local`, and lasts 820
   days; `bazhen doctor` shows when it expires.

4. Run `bazhen devices pair`. Besides the code, it prints the address to open, such as
   `https://my-mac.local:7942`, the certificate's SHA-256 fingerprint and when the certificate
   expires.

5. On the device, open that address. The browser warns that the certificate isn't trusted. Open
   its details (Safari: Show Details, then view the certificate) and compare the SHA-256 with the
   one `bazhen devices pair` printed, every pair of characters; both are lowercase. Only if they match,
   choose to visit the site.

6. Enter the pairing code.

**If the fingerprints don't match, stop.** Don't trust the certificate and don't pair: something
on the network is standing in for Bazhen, and it would see the code and everything after it.

With `listen = "lan"`, every browser must pair, on this machine's loopback too, as with an
external origin. A browser paired over the LAN stays paired until it goes 30 days unused.

## When the certificate can't be used

If the certificate or its key is damaged, readable by other users, or expired, Bazhen keeps
serving loopback and logs why it isn't serving the LAN; `bazhen doctor` says so too. It never
replaces the certificate by itself, since the fingerprint you checked would change without telling
you. To make a new one, stop Bazhen, delete the `tls` directory the message names, and start it
again. Then trust the new fingerprint on each device as in step 5. Paired devices stay paired.

If the listener itself fails, for example because its port is taken, it stops alone in the same
way: loopback keeps serving, and the log and `bazhen doctor` say why.

## What protects it

- Only devices in `lan_allow` reach the listener at all. That isn't authentication: a device that
  takes an address in the range, or a router's port forward, gets past it.
- Pairing is the authentication: the code works once, for 5 minutes, and each device's attempts
  are limited.
- Every pairing shows on this machine's desktop as it happens, and in the inbox as a new device,
  with the name it gave, the address it paired from and when. **The desktop notification is the
  signal**: a pairing you didn't expect means a code was taken, so revoke the device
  (`bazhen devices revoke <id>`). No browser can dismiss a pairing's notice, its own or another's;
  only this machine can, with `bazhen devices dismiss <id>`, and `bazhen devices` marks each new
  device until then. That isn't a lock, since a paired device can do anything you can, a shell
  and the CLI included: the inbox notes when a dismissal came from a paired device's shell, as a
  lead, but a device that wants to hide can.
- The listener holds 64 connections, at most 16 from any one device address, and a handshake must
  finish within 10 seconds, so one device can't take every connection.
- TLS 1.3 only. The certificate can't sign other certificates, so even someone who copies its key
  from this machine can only impersonate Bazhen's `.local` name, nothing else.
- Backups of the state directory carry the key, with the same reach.

Never forward the port to the internet.
