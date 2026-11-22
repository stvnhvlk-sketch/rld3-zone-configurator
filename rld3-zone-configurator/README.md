# RLD3 Zone Configurator — Home Assistant add-on

Runs the [RLD3-Target zone configurator](../configurator/) as a Home Assistant
add-on with **ingress**: it shows up as a sidebar panel (no extra port, HA does
the auth), serves the static UI over nginx, and the page talks straight to your
Mosquitto add-on over MQTT-WebSocket to provision the device and stream live
targets.

## Install

**As a repository (recommended — no filesystem access to HA needed):**

1. Settings → Add-ons → Add-on Store → ⋮ (top-right) → **Repositories**.
2. Add the repo URL (the GitHub/git URL of this project), **Add**, close.
3. The store now lists **RLD3 Zone Configurator** under this repo — open it,
   **Install**, then **Start**. "Show in sidebar" gives the panel.

**As a local add-on (alternative):** copy this `rld3-zone-configurator/` folder
into HA's `/addons` share (via the Samba or SSH add-on), reload the store, and
install it from **Local add-ons**.

## Use

Open the panel from the sidebar. In the **Device (live MQTT)** panel, point it at
your broker's MQTT-over-WebSocket endpoint (the HA Mosquitto add-on exposes this
on port **1884**), Connect, then draw → Provision. See the configurator
[README](../configurator/README.md) for the workflow.

> **Mixed content:** the page connects to the broker with `ws://…:1884`. That
> works when you reach HA over plain `http://`. If you front HA with HTTPS (Nabu
> Casa / a TLS reverse proxy), browsers block insecure `ws://` from an `https://`
> page — use a `wss://` broker endpoint in that case.

## What's new

Updated: 2026-09-20 — this list had stopped at 0.5.0 while `config.yaml` was
at 0.6.5; the 0.5.4–0.6.5 entries below are reconstructed from the source
commits. `publish.sh --check` (run 2026-09-20) confirms the published repo
matches this tree at 0.6.5.

### 0.6.5 — restart interface revision 1 (2026-09-13)
- `www/` resynced for the `layout_codec` changes that accept the restart
  firmware's interface revision 1 (`a5c693d`). This is the first add-on
  version that talks to both firmwares.

### 0.6.3 / 0.6.4 — zone styles settled (2026-08-23..25)
- `WALKWAY` and the original `TRANSIT_ONLY` retired — a hand-aimed filter is a
  guess (`a8400e0`); `TRANSIT_ONLY` restored with a split scope and a
  `FORBIDDEN` start (`18d5364`). The policy table is in
  `_Documentation/zone-styles-design.md`.

### 0.6.2 — 0.6.0 back-ported (2026-08-17..22)
- The **Occupancy Zone style selector** (0.6.0) had been built only in the
  published repo; back-ported into `configurator/` (`2f0058d`) and the add-on
  resynced from source (`167790a`). `publish.sh` exists so this cannot recur.

### 0.5.4 — no-cache (2026-08-07)
- HTML/JS served with `Cache-Control: no-cache`: an updated add-on showed the
  old page until a hard refresh.

### 0.5.0 — yaw is the aim you set

- **"Apply suggested yaw" is gone.** Yaw is now the aim you author in the layout,
  not a value derived from a measurement. Place the sensor, then **drag the handle
  at the end of its aim line** (Place Sensor mode) to point the optimal ±45° cone
  where you want coverage — that sets Yaw. The Yaw field is still typeable.
  Yaw Align's job is to rotate the physical head to match; its readout is now a
  read-only check that reports how far off the head is.
- **"You Are Here" is one-shot.** Placing the dot returns to Pan, so a later
  canvas click can no longer nudge it. The readout shows the dot's room
  coordinates, and Clear dot is duplicated next to the mode button.
- **Connect no longer over-claims.** It verifies with a read; if the sensor
  doesn't answer you get "sensor not responding" instead of a green "connected"
  for what is really just a reachable broker.
- **Live view no longer freezes after a Read** (two MQTT message handlers were
  silently evicting each other).
- **Export is labelled "Export Layout JSON"** — it captures mount + zone geometry
  only, *not* device tuning. It is not a device backup.

## Updating

The web assets are vendored under `www/`. After changing
[`../configurator/`](../configurator/): `./sync-www.sh`, bump `version` in
[`config.yaml`](config.yaml), add a line above, then **`./publish.sh`** — which
syncs, verifies, commits and pushes to the repository Home Assistant actually
installs from (`github.com/stvnhvlk-sketch/rld3-zone-configurator`). Pushing
RLD3Target alone changes nothing in HA; the pair diverged three times before
the script existed (its header has the dates). `ci.sh` runs `sync-www.sh
--check` (source ⇄ `www/`); `publish.sh --check` is the source ⇄ published
check and is run by hand.
