#!/usr/bin/env bash
# Mirror the configurator's UI + core modules into www/ (the add-on web root).
# Source of truth stays in ../configurator; run this whenever it changes, then
# bump version in config.yaml and rebuild the add-on.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
src="$here/../configurator"

[ -d "$src/ui" ] && [ -d "$src/src" ] || { echo "configurator/ui or /src missing at $src" >&2; exit 1; }

rm -rf "$here/www/ui" "$here/www/src"
mkdir -p "$here/www"
cp -r "$src/ui"  "$here/www/ui"
cp -r "$src/src" "$here/www/src"

# Root entry: relative meta-refresh into the app. Relative so the HA ingress
# path prefix (…/api/hassio_ingress/<token>/) is preserved by the browser.
cat > "$here/www/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8" />
<meta http-equiv="refresh" content="0; url=ui/index.html" />
<title>RLD3 Zone Configurator</title>
<p><a href="ui/index.html">RLD3 Zone Configurator</a></p>
HTML

echo "synced ui/ + src/ and wrote www/index.html"
