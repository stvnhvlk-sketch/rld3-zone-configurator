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

## Updating

The web assets are vendored under `www/`. After changing
[`../configurator/`](../configurator/), run `./sync-www.sh`, bump `version` in
[`config.yaml`](config.yaml), and rebuild/update the add-on.
