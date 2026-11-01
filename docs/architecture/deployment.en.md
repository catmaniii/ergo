[中文](deployment.md) | **English**

# Deployment and outside access

ergo lives on your own Windows PC, hosted by the service manager and started at boot. This page covers the technical details of reaching that PC from a phone or tablet. For how to choose, how to connect Tailscale and how to pair, [On your phone](../user-guide/mobile.en.md) is all you need; for pairing rules see [Device pairing](README.en.md#device-pairing); for security boundaries see [SECURITY.md](../../SECURITY.md).

By default ergo is only used on this PC (`http://127.0.0.1:8810/`). There are three ways to use it from a phone or tablet; **the first is recommended**.

> **Hard rule**: all three must connect only to ergo's **external port 8811**, where every request needs a device credential and new devices must be approved on your PC. **Never expose the local port 8810 through Tailscale Serve, a tunnel or a reverse proxy**: requests from the local port are trusted automatically, so exposing it lets your whole tailnet (or the whole internet) in without authentication.

The address on the pairing code comes from the service manager: only entries that go to the external port count, public first, then tailnet, with the ones reached from outside on top. For anything the service manager doesn't know about (a hand-run `tailscale serve`, your own reverse proxy, frp), enter a fixed address on the pairing page. The code only holds the address, and pairing rules don't change. Local network addresses don't count. Pending requests expire after 5 minutes; one source can request at most 5 times per 10 minutes.

| | Option 1: Tailscale (recommended) | Option 2: self-hosted Headscale (advanced) | Option 3: VPS + tunnel + nginx (public) |
|---|---|---|---|
| Needs | Tailscale on PC and phone, same account | A VPS running Headscale | A VPS and a domain certificate |
| Who can open it | Only devices in your tailnet | Only devices in your tailnet | Any browser (pairing is the only gate) |
| HTTPS certificate | Provided by Tailscale | certbot on the VPS | certbot on the VPS |
| Difficulty | Easiest | Medium | Hardest |
| Notes | Sign-in uses a Google / Microsoft / GitHub… account; relays are abroad and may be slow in mainland China | You can run your own relay, fast in China | Exposed to the internet; strangers can see the pairing page |

## Option 1: Tailscale (recommended)

The steps are in [On your phone](../user-guide/mobile.en.md). How it works: `tailscale serve` serves local port **8811** over HTTPS to your tailnet; Tailscale provides the certificate, and MagicDNS and HTTPS certificates must be enabled in its admin console.

## Option 2: self-hosted Headscale (advanced)

For people who want to own the control server, or need speed inside China. On a Debian / Ubuntu VPS, one command installs [Headscale](https://github.com/juanfont/headscale) (optionally with your own DERP relay):

```powershell
lsm vps setup headscale --host root@<VPS IP>    # inside packages\supervisor; then lsm vps status shows whether it works
```

The Tailscale clients on the PC and phone both log into your own Headscale; the service manager's **tailnet entry** then gives ergo an HTTPS address reachable only inside your tailnet (certbot on the VPS issues a real certificate, Headscale's DNS records point the name back to your PC, and a local gateway terminates TLS and forwards to 8811):

```powershell
node bin\lsm.mjs tailnet ergo-daemon on <name>
```

What each step does is in [vps.md](../../packages/supervisor/docs/vps.md) and under "可选功能" (optional features), "tailnet 入口" (tailnet entry), in the service manager's [README](../../packages/supervisor/README.md); both are in Chinese. **The VPS side has not been tried on a real Debian machine yet** (only the PC side has been run, on Windows), so follow the docs step by step the first time.

## Option 3: VPS + ssh reverse tunnel + nginx (public)

Path: `https://ergo.<VPS IP>.sslip.io` → nginx on the VPS (HTTPS) → `127.0.0.1:18811` on the VPS → ssh reverse tunnel (`ergo-tunnel`) → the daemon's external port 8811 on your PC. ergo never connects to the VPS itself.

One command sets this up: `lsm vps setup tunnel --host root@<VPS IP>` (inside `packages\supervisor`); `lsm vps status` shows whether it works. If the VPS already has sites, `lsm vps site add` / `site remove` / `certs` / `scan` handle certificates and sites — see [vps-https.md](../../packages/supervisor/docs/vps-https.md) (in Chinese). **The VPS side has not been tried on a real Debian machine yet.**

If you would rather not use that command, you do each step below yourself.

1. **Config**: fill in `publicAccess` in `ergo.json` (see `config\ergo.example.json`): the VPS public IP, ssh user, absolute path to the ssh private key; `nginx.listen` (`443 ssl` if nginx listens on 443 directly; if a SNI-based front door sits in front, the local port it forwards to, e.g. `127.0.0.1:8443 ssl`); `nginx.certificateDir` (where the existing certificate lives).
2. **Certificate**: with your existing Let's Encrypt setup on the VPS, add `ergo.<VPS IP>.sslip.io` to the certificate.
3. **Preview** the nginx config: `npm run deploy:nginx -- --print` (prints only; does not connect).
4. **Deploy**: `npm run deploy:nginx`. It ssh-es to the VPS, writes the site config, reloads only if `nginx -t` passes, and restores the previous config otherwise.
5. **Register the tunnel**: copy `deploy\lsm\ergo-tunnel.example.yaml` to `registry\services\ergo-tunnel.yaml` in the service manager's data directory and replace the placeholders (`<仓库路径>` the repository path, `<ssh 私钥路径>` the ssh private key path, `<VPS 用户>` the VPS user, `<VPS 地址>` the VPS address); in `ergo-daemon.yaml` turn on the `exposure:` block: from-source installs uncomment it at the end, one-line and npm installs add one copied from the end of `deploy\lsm\ergo-daemon.example.yaml`, and either way replace `<VPS 地址>`. `ergo start` and updates keep this block when they rewrite the file. Then:

   ```powershell
   node bin\lsm.mjs validate
   node bin\lsm.mjs reload
   node bin\lsm.mjs start ergo-tunnel
   node bin\lsm.mjs autostart ergo-tunnel on
   ```

6. Open `https://ergo.<VPS IP>.sslip.io/` on the phone and pair.

Behind a SNI front door without `proxy_protocol`, nginx sees every client as 127.0.0.1: the pairing card shows the source as "Forwarded by the front door, can't be identified", and pairing rate limits become global (still safe, but if strangers spam requests your own pairing waits 10 minutes too). For per-client limits, enable `proxy_protocol` on the front door and set `nginx.clientAddress` to `$proxy_protocol_addr`; this affects every site behind that front door, so it is your call.
