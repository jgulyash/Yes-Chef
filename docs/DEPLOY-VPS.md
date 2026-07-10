# Running Yes Chef! on a VPS

A VPS (a small rented Linux server — e.g. a $5/month instance at any cloud provider) is a
fine always-on host for Yes Chef! if you don't have a home NAS. Because the app is a single
Docker container, the mechanics are easy. The **security** is the part that needs care, so
read the box below before you start.

> ## ⚠️ Read this first: Yes Chef! has no built-in authentication
>
> The app trusts anyone who can reach it — there is no login, no password, no API key.
> That's fine on a home LAN or over a private VPN, which is what it was designed for. On a
> VPS it is **not** fine: a VPS has a public IP, so exposing the app's port to the internet
> means **anyone who finds the address can read and modify your kitchen data and upload
> files.** Built-in authentication and multi-household support are on the roadmap; until they
> ship, access control is entirely the deployment's responsibility (a private network, a VPN,
> or an authenticating proxy).
>
> So never publish the raw port. Pick one of the two paths below — both keep the app
> unreachable to the anonymous internet:
>
> - **Path A — Private (recommended, simplest):** the VPS is just your always-on host; you
>   reach the app over a private VPN (Tailscale/WireGuard). Nothing is exposed publicly. This
>   is the same model as the NAS guide, minus the NAS.
> - **Path B — Public (more work):** you put a reverse proxy in front that adds HTTPS **and**
>   an authentication layer. Only do this if you actually need public access.

---

## Prerequisites (both paths)

- A VPS running a recent Linux (Debian/Ubuntu shown here) with **Docker** and the **Docker
  Compose plugin** installed.
- The Yes Chef! `app/` folder on the server (via `git clone`, `scp`, or an rsync).
- SSH access to the box.

```bash
# On the VPS, from inside the app/ folder:
cd app
docker compose up -d --build     # builds the image and starts the container
docker compose logs -f           # watch for "Yes Chef! Stage-1 running at http://localhost:3000"
```

At this point the app is running and listening on port 3000 **inside the server**. Do **not**
add a firewall rule opening 3000 to the world. The two paths below differ only in how *you*
reach it.

> The SQLite database is bind-mounted to `./db` on the host (see `docker-compose.yml`), so it
> survives restarts and rebuilds. Back it up like any other file — e.g. a nightly
> `cp db/yeschef.db db/backups/` cron job, or your provider's volume snapshots. The whole
> memory of the system is that one file.

---

## Path A — Private access over Tailscale (recommended)

*Why: Tailscale puts the VPS and your phone on the same private network, so you reach the app
by a name only your devices know. The app's port never touches the public internet, so the
missing-auth problem simply doesn't apply.*

1. Install Tailscale on the VPS and sign in:
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
   The VPS now has a private `100.x.y.z` address (and a `*.ts.net` name) visible only to your
   Tailscale account.
2. Install the Tailscale app on your phone/laptop and sign in with the same account.
3. Make sure the container is published only where Tailscale can reach it. In
   `docker-compose.yml`, the default `- "3000:3000"` binds all interfaces; on a VPS, bind it
   to localhost instead and let Tailscale serve it, **or** rely on the host firewall to block
   3000 from the public interface. The simplest robust option is Tailscale Serve:
   ```bash
   sudo tailscale serve --bg 3000     # serves the app over HTTPS on your tailnet only
   ```
4. From any of your devices with Tailscale on, open the VPS's `*.ts.net` name (Tailscale
   Serve gives you an HTTPS URL). Add it to your home screen like any PWA.

That's it — always-on hosting, private access, no public exposure, HTTPS for free (so the
offline service worker works too). WireGuard or Tailscale's alternatives work the same way if
you prefer.

---

## Path B — Public access behind a reverse proxy with auth (advanced)

*Why: if you genuinely need the app reachable from a normal browser with no VPN, you must add
the two things the app itself doesn't provide — TLS and authentication — in front of it. A
reverse proxy is where both live.*

This is a sketch, not a click-by-click, because the right auth layer depends on your setup.
The non-negotiable requirements:

1. **Keep the app on localhost.** In `docker-compose.yml` change the port mapping to
   `- "127.0.0.1:3000:3000"` so the container is not reachable from outside the VPS at all.
2. **Terminate HTTPS at a reverse proxy.** [Caddy](https://caddyserver.com) is the least-effort
   option — it gets and renews Let's Encrypt certificates automatically. A minimal `Caddyfile`:
   ```
   yeschef.example.com {
       # Authentication FIRST — see step 3. Without it, the line below publishes your kitchen.
       reverse_proxy 127.0.0.1:3000
   }
   ```
3. **Add authentication at the proxy — this is the load-bearing step.** Options, roughly in
   order of strength:
   - **Basic auth** — Caddy's `basic_auth` directive. Crude but real; one shared password.
   - **An auth gateway** — [Authelia](https://www.authelia.com) or
     [oauth2-proxy](https://github.com/oauth2-proxy/oauth2-proxy) in front, giving you real
     logins / SSO / 2FA.
   - **A zero-trust access layer** — e.g. Cloudflare Access — which authenticates users before
     any request reaches your proxy at all.
4. **Lock down the host firewall.** Allow only 80/443 (and your SSH port) from the public
   internet; never 3000.

Because Yes Chef! has no concept of users, everyone who gets past the proxy is the *same*
household — the proxy is your only access boundary. Treat its auth config as the thing
protecting your data, and keep it patched. If per-user accounts inside the app matter to you,
that's the planned auth phase, not something the proxy can add.

---

## Which should I use?

- **You just want it always-on and reachable from your phone:** Path A (Tailscale). Simplest,
  safest, matches how the app was designed.
- **You need to share it with someone who won't install a VPN client, or want a real URL:**
  Path B, and budget the time to set up the auth gateway properly.
- **You have a home NAS:** you probably don't need a VPS at all — see
  [../app/DEPLOY-SYNOLOGY.md](../app/DEPLOY-SYNOLOGY.md).
