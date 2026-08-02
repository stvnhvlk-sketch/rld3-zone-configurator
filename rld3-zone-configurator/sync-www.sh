#!/usr/bin/env bash
# Mirror the configurator's UI + core modules into www/ (the add-on web root).
# Source of truth stays in ../configurator; run this whenever it changes, then
# bump version in config.yaml and rebuild the add-on.
#
#   sync-www.sh            regenerate www/
#   sync-www.sh --check    verify www/ matches the source; exit 1 on drift
#
# --check exists because "run this whenever it changes" is a safeguard nobody
# verifies (CP-A-70). www/ is a COPY of ../configurator, and an unguarded copy
# is what rotted the shared coding rules to 8% agreement before they were
# generated with a drift check. The failure here is quiet in the same way: edit
# configurator/ui/, forget to sync, and the add-on ships a stale UI whose
# symptom -- a fix that appears not to work -- is indistinguishable from the fix
# being wrong. ci.sh runs --check so it cannot happen silently.
#
# A copy is not a duplicate if it cannot drift.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
src="$here/../configurator"

[ -d "$src/ui" ] && [ -d "$src/src" ] || { echo "configurator/ui or /src missing at $src" >&2; exit 1; }

# One builder, used by both modes. If the check built the tree differently from
# the sync, the check would be measuring itself rather than the copy.
build_into() {
    local dest="$1"
    rm -rf "$dest/ui" "$dest/src"
    mkdir -p "$dest"
    cp -r "$src/ui"  "$dest/ui"
    cp -r "$src/src" "$dest/src"

    # Root entry: relative meta-refresh into the app. Relative so the HA ingress
    # path prefix (…/api/hassio_ingress/<token>/) is preserved by the browser.
    cat > "$dest/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8" />
<meta http-equiv="refresh" content="0; url=ui/index.html" />
<title>RLD3 Zone Configurator</title>
<p><a href="ui/index.html">RLD3 Zone Configurator</a></p>
HTML
}

if [ "${1:-}" = "--check" ]; then
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    build_into "$tmp/www"
    # --strip-trailing-cr: a Windows checkout is CRLF and anguirus is LF, and a
    # line-ending difference here is not drift. Ignoring it has been the wrong
    # call five times in this workspace when comparing files.
    if diff -r --strip-trailing-cr "$tmp/www" "$here/www" >/dev/null 2>&1; then
        echo "www/ matches configurator/"
        exit 0
    fi
    echo "DRIFT: rld3-zone-configurator/www/ does not match configurator/." >&2
    echo "       Someone edited the configurator without re-syncing the add-on," >&2
    echo "       or edited www/ directly. www/ is generated; do not edit it." >&2
    echo "       Fix: rld3-zone-configurator/sync-www.sh  (then bump config.yaml)" >&2
    diff -rq --strip-trailing-cr "$tmp/www" "$here/www" 2>&1 \
        | sed "s|$tmp/www|EXPECTED|; s|$here/www|COMMITTED|; s|^|       |" >&2 || true
    exit 1
fi

build_into "$here/www"
echo "synced ui/ + src/ and wrote www/index.html"
