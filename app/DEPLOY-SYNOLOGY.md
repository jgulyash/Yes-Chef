# Running Yes Chef! on your Synology NAS (step by step)

This guide takes you from "I have the code" to "I can open Yes Chef! on my phone in the
kitchen, and from anywhere over your own VPN/zero-trust app (e.g. Tailscale or Twingate)." It's written for someone who is **not** a
network engineer: every step says **what to click** and **why you're doing it**. Take it
slowly; you only do this once.

**What you'll end up with**

- Yes Chef! running 24/7 in a container on your Synology NAS (it is always on, so the app
  is always ready).
- Its database stored in a normal folder on the NAS, so it survives restarts and gets
  picked up by your existing NAS backups.
- Reachable at `http://<your-NAS-IP>:3000` on your home Wi‑Fi, and from anywhere through
  your VPN app, with nothing exposed to the public internet.

**Why a container at all?** A container is a sealed box that already contains the right
version of everything Yes Chef! needs. You don't install Node or fiddle with versions on
the NAS; Container Manager just runs the box. It's the cleanest, most repeatable way to run
an app on a Synology.

---

## Before you start

- Your NAS is on and you can log in to **DSM** (the Synology web desktop) from your computer.
- **Container Manager** is installed. Check: open **Package Center**, search
  *Container Manager*, install it if it isn't already. (On older DSM it was called "Docker";
  the steps are the same.)
- You have the Yes Chef! code. You only need the **`app`** folder from the repository.

---

## Part A — Put the code on the NAS

*Why: Container Manager builds the app from these files, so they need to live on the NAS in
a folder it can see.*

1. On your computer, download the repository from GitHub (green **Code** button →
   **Download ZIP**) and unzip it. Inside you'll find a folder named **`app`** — that's the
   only part you need.
2. In DSM, open **File Station** (the folder icon on the DSM desktop).
3. If you don't already have a shared folder for containers, make one:
   - **Control Panel → Shared Folder → Create → Create Shared Folder**.
   - Name it **`docker`**, click through the wizard, accept the defaults, **Apply**.
   - *Why: keeping all container apps under one `docker` shared folder keeps things tidy and
     makes them easy to include in backups.*
4. Back in **File Station**, open the **`docker`** shared folder and create a new folder
   inside it called **`yeschef`** (right-click → **Create folder**).
5. **Upload** the *contents* of the `app` folder into `docker/yeschef`. Drag the files and
   folders (`Dockerfile`, `docker-compose.yml`, `package.json`, `src`, `public`, `data`,
   etc.) into `docker/yeschef`.
   - When you're done, `docker/yeschef` should directly contain `Dockerfile` and
     `docker-compose.yml` (not an extra `app` folder in between).
   - *Why: Container Manager will point at this exact folder, and it expects the
     `docker-compose.yml` to be right there.*

---

## Part B — (Optional but recommended) set your own staples

*Why: the app ships with 30 generic staples so it works immediately. Replacing them with
what **you** actually buy is what makes the weekly list useful. Do this now, because the
list is loaded into the database only the first time the app starts.*

1. In **File Station**, go to `docker/yeschef/data` and find **`staples.json`**.
2. Download it, open it in any text editor, and edit the list. The notes at the top of the
   file explain every field in plain language (what `zone`, `par`, `reorder_point`,
   `consumption_rate`, `init`, and `aliases` mean).
3. Save it and upload it back to `docker/yeschef/data`, replacing the old one.
4. If you'd rather not touch it now, skip this — you can change staples later (see
   *Changing your staples later* near the end).

---

## Part C — Build and start the app in Container Manager

*Why: this turns the files into a running container. A "Project" in Container Manager is
just its name for "run this `docker-compose.yml`."*

1. Open **Container Manager** from the DSM desktop.
2. In the left sidebar, click **Project**, then **Create**.
3. Fill in the form:
   - **Project name:** `yeschef`
   - **Path:** click **Set Path / Select**, browse to `docker/yeschef`, and choose it.
   - **Source:** it should detect the existing **`docker-compose.yml`** in that folder and
     show its contents. (If it asks, choose *Use existing docker-compose.yml*.)
4. Click **Next** through any prompts. If it offers to set up a web portal/reverse proxy,
   you can **skip** that — we don't need it.
5. Click **Done / Build**. Container Manager will now **download the base image and build
   the app**. The first build takes a few minutes (it's fetching Node and installing
   things); later starts are instant. You can watch progress in the build log.
   - *Why it takes a minute the first time: it's assembling that sealed box. It only does
     the heavy work once.*
6. When it finishes, the project shows the **`yeschef`** container as **Running** (green).
   Click the container → **Log** to confirm you see a line like
   `Yes Chef! Stage-1 running at http://localhost:3000` and
   `seeded 30 staples` (or your own count).

That's it — the app is live on the NAS. Now let's reach it.

---

## Part D — Open it on your phone at home

*Why: in the kitchen you're on your home Wi‑Fi, so your phone can talk to the NAS directly.
You just need the NAS's address on your network.*

1. Find your NAS's local IP address: **Control Panel → Network → Network Interface**, click
   your **LAN** connection. You'll see something like **`192.168.1.50`**. Write it down.
   - *Why: that number is your NAS's "house address" on your home network.*
2. On your phone (connected to your home Wi‑Fi), open a browser and go to:
   **`http://192.168.1.50:3000`** (use your actual NAS IP).
3. You should see the Yes Chef! Kitchen — your places (Pantry, Fridge, Freezer…), the
   "to buy this week" tile, and anything that needs attention. 🎉
4. **Add it to your home screen** so it feels like an app:
   - **iPhone/Safari:** tap the **Share** icon → **Add to Home Screen**.
   - *Why: this gives you a one-tap icon instead of typing the address every time.*

> Tip: if your NAS IP ever changes, give the NAS a fixed address. In your router, reserve a
> "static DHCP" lease for the NAS, or set a manual IP in **Control Panel → Network →
> Network Interface → Edit**. Not required to start, but it stops the address from moving.

---

## Part E — Reach it when you’re away (VPN/zero-trust)

*Why: when you leave the house, your phone is no longer on your home Wi‑Fi, so the
`192.168...` address won't work. A zero-trust VPN app creates a private, secure path back to your NAS
without opening any ports to the public internet. If you already run such an app on the
NAS, the hard part is done.*

1. Make sure your NAS is running your provider's **connector/agent**. (In the provider's
   admin console, your NAS should show up under connectors/devices.)
2. In your provider’s **admin console**, go to your
   network and click **Add Resource**.
   - **Address:** enter your NAS's local IP, e.g. **`192.168.1.50`** (the same one from
     Part D). You can give it a friendly name like *Yes Chef (NAS)*.
   - **Connector:** make sure it's the connector running on/at your NAS.
   - *Why: this tells the app "when I ask for the NAS, route me there privately through the
     connector inside my home."*
3. Under that resource's **Access**, grant access to **yourself** (your user/group).
   - *Why: zero-trust tools are deny-by-default. Nothing can reach the NAS through it unless you
     explicitly allow it — that's the zero-trust model doing its job.*
4. On your **phone**, make sure your **VPN app** is installed, signed in, and **On**.
5. With the VPN app on, open **`http://192.168.1.50:3000`** on your phone from anywhere. It
   works exactly like being at home, because it quietly tunnels you in.
   - *Note: at home you don’t need it; off Wi‑Fi you do. It’s fine to leave the
     app on all the time.*

---

## Part F — Backups (don't skip this)

*Why: the file at `docker/yeschef/db/yeschef.db` is the entire memory of the system — your
counts, your history, and the aliases it has learned. If you back up that folder, you can
never really lose your setup.*

- Your container writes the database to **`docker/yeschef/db`** on the NAS (the
  `./db:/data` line in the compose file maps it there).
- Include the **`docker`** shared folder (or at least `docker/yeschef/db`) in your existing
  backup job:
  - **Hyper Backup** (Package Center) → your backup task → make sure the `docker` shared
    folder is selected. Or use **Snapshot Replication** if your volume is Btrfs.
- That's all. Because it's just a file in a normal folder, your usual NAS backup covers it
  with no special handling.

---

## Keeping it running / common tasks

**Updating to a new version of the app**
See *Updating the app to a new version* below — in particular the step about deleting the
old image first. Clicking **Build** alone does **not** rebuild the app if an image already
exists; it quietly restarts the old version.

**Changing your items later**
You don't need this file after the first run: **add, edit, and remove items directly in
the app** (each place has "＋ Add an item"; an item's detail screen edits everything and
has "Remove from kitchen" — removal keeps history, and re-adding the same name brings it
back). `staples.json` only matters for the very first start on an empty database.

**One-time: create the media folder (for kitchen-pass videos)**
The app stores recorded kitchen-pass videos in a `media` folder next to `db`. Synology
does not auto-create bind-mount folders, so before the FIRST start after adding video:
in **File Station**, open `docker/yeschef` and create an empty folder named **`media`**
(same as you did for `db`).

**Updating the app to a new version**
1. Upload the changed files into `docker/yeschef` (replacing the old ones).
2. If anything in `public/` changed, make sure `VERSION` at the top of `public/sw.js`
   was bumped (see *The app on your phone* above).
3. **Delete the old image first — this step is not optional.** Container Manager's
   **Build** does *not* rebuild the app when a `yeschef:latest` image already exists; it
   just restarts the old one, and everything looks like it worked. Do it in this order:
   - **Project → yeschef → Action → Stop**, then **Action → Clean** (removes the
     container; your `db/` and `media/` folders are normal NAS folders and are untouched).
   - **Image** (left sidebar) → select **yeschef** → **Delete** → confirm.
4. **Project → yeschef → Action → Build**. Now you'll see the real build: 25 steps,
   `npm ci`, the full test suite (the build fails if any test fails — that's the safety
   gate), then `Container yeschef Started`. Your database is untouched, and any new
   database migrations run automatically on start — you'll see them in the container log.
5. **Verify it actually updated:** open `http://<NAS-IP>:3000/sw.js` in a browser and
   check the `VERSION` line matches the new version. If it still shows the old one, the
   old image got reused — go back to step 3.

> **If a Build/Stop leaves a weird container behind** (a name like `b0edd67d8c27_yeschef`,
> and clicking it says "Container undefined does not exist"): DSM's display has come apart
> from Docker itself — the real container underneath is still named `yeschef`. Restarting
> the whole Container Manager package (Package Center → Container Manager → Stop, then
> Start) clears the confusion, after which Stop/Clean/Delete work normally. Then continue
> from step 3.

**Your stores**
`docker/yeschef/data/stores.json` seeds your store list (e.g. your grocery store, a warehouse club, …) the same
way: first run only, when the store table is empty. After that, manage stores in the
app (they're editable data, like staples). Override the file location with the
`YESCHEF_STORES` environment variable if you keep it elsewhere.

**The app on your phone (PWA)**
Two rules the app's offline support depends on:
1. **Every time you change app files** (anything in `public/`), also bump the
   `VERSION` string at the top of `public/sw.js` (e.g. `yc-v3` → `yc-v4`) before
   rebuilding — phones keep the OLD cached app until that version changes.
2. Offline support (the service worker) only activates over **HTTPS or localhost**.
   Over plain `http://<NAS-IP>:3000` the app works fully but won't cache for offline —
   to get offline + install banners, put the app behind Synology's reverse proxy with
   a certificate (DSM → Login Portal → Advanced → Reverse Proxy) or access via your VPN app
   with a TLS name. "Add to Home Screen" still works either way.

**Restarting**
Container Manager → **Project → yeschef → Stop / Start**. The app also restarts itself
automatically if the NAS reboots.

---

## Troubleshooting

- **Phone can't load the page at home.** Double-check the NAS IP (Part D step 1) and that
  you typed `http://` (not `https://`) and `:3000`. Make sure the phone is on your home
  Wi‑Fi, not cellular.
- **Page works at home but not away.** That’s the VPN layer: confirm the app on your
  phone is signed in and **On**, and that the Resource (Part E) has **your** access granted.
- **Container won't start / build failed.** Open **Container Manager → Project → yeschef →
  Log**. The most common cause is the files not sitting directly in `docker/yeschef` (you
  should see `Dockerfile` and `docker-compose.yml` right there, not nested in another `app`
  folder).
- **Port 3000 already in use.** Edit `docker-compose.yml` and change the left number in
  `"3000:3000"` to something free, e.g. `"3100:3000"`, then rebuild. You'd then use
  `:3100` in the browser.
