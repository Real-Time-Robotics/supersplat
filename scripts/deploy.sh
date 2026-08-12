#!/usr/bin/env bash
# Ship the editor to Cloudflare Workers.
#   scripts/deploy.sh              # gate -> bump patch -> build+deploy -> smoke
#   scripts/deploy.sh --no-bump    # same, keeping the current version
#
# Creds live in ~/.config/genesis/cloudflare.env (0600):
#   CLOUDFLARE_API_TOKEN=...     # Workers Scripts: Edit + zone Workers Routes: Edit
#   CLOUDFLARE_ACCOUNT_ID=...
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

CREDS="${CLOUDFLARE_ENV:-$HOME/.config/genesis/cloudflare.env}"
SITE="${SITE_URL:-https://editor.rtrobotics.com}"
BUMP=1
[ "${1:-}" = "--no-bump" ] && BUMP=0

# nvm installs node outside the login path.
# Resolved rather than hard-coded so a node upgrade does not break this.
if ! command -v node >/dev/null 2>&1; then
    node_bin="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
    [ -n "$node_bin" ] || { echo "ERROR: no node on PATH and none under ~/.nvm" >&2; exit 1; }
    export PATH="$node_bin:$PATH"
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    [ -f "$CREDS" ] || { echo "ERROR: no CLOUDFLARE_API_TOKEN and no $CREDS" >&2; exit 1; }
    set -a; . "$CREDS"; set +a
fi
: "${CLOUDFLARE_API_TOKEN:?set it in $CREDS}"
: "${CLOUDFLARE_ACCOUNT_ID:?set it in $CREDS}"

step() { echo; echo "==== $* ===="; }

# Gate before mutating package.json.
step "typecheck"
npx tsc --noEmit -p tsconfig.json
step "lint"
npx eslint src worker
step "tests"
npm run test:ui
npm run test:backend
npm run test:auth-session
npm run test:session-durable
npm run test:gateway-proxy
npm run test:runs-freshness
npm run test:model-import

# prebuild bundles the linked Genesis SDK.
if [ "$BUMP" = 1 ]; then
    step "bump patch"
    npm version patch --no-git-tag-version
fi
version="$(node -p 'require("./package.json").version')"

# Smoke decides success because route updates can fail after upload.
step "deploy $version"
set +e
npm run deploy
deploy_rc=$?
set -e
[ "$deploy_rc" = 0 ] || echo "WARN: wrangler exited $deploy_rc -- smoke decides" >&2

step "smoke"
# Cloudflare serves the previous bundle for a few seconds after the upload, so the
# bundle check retries rather than reporting a deploy that did land as failed.
built="$(md5sum dist/index.js | cut -d' ' -f1)"
live=""
for _ in 1 2 3 4 5 6; do
    live="$(curl -s "$SITE/index.js" | md5sum | cut -d' ' -f1)"
    [ "$live" = "$built" ] && break
    sleep 5
done
root="$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "$SITE/")"
# The proxy must refuse an unauthenticated session probe. A 200 here would mean the
# gateway route is open, which is worse than a failed deploy.
session="$(curl -s -o /dev/null -w '%{http_code}' "$SITE/api/reconstruction/session")"
echo "GET /                              -> $root"
echo "GET /api/reconstruction/session    -> $session"
echo "GET /index.js                      -> $live (built $built)"

fail=0
case "$root" in 200\ text/html*) ;; *) echo "FAIL: / expected 200 text/html" >&2; fail=1 ;; esac
[ "$session" = 401 ] || { echo "FAIL: session expected 401, got $session" >&2; fail=1; }
[ "$live" = "$built" ] || { echo "FAIL: the live bundle is not the one just built" >&2; fail=1; }
# A caching worker would make every future deploy invisible to an open tab, which is not
# something the next release would notice on its own.
case "$(curl -s "$SITE/sw.js")" in
    *registration.unregister*) ;;
    *) echo "FAIL: /sw.js is not the self-destruct -- open tabs will stay on old code" >&2; fail=1 ;;
esac
[ "$fail" = 0 ] || exit 1

if [ "$deploy_rc" != 0 ]; then
    echo
    echo "Live and healthy, but wrangler exited $deploy_rc: the script uploaded and the"
    echo "route already resolves, so this is the token missing zone Workers Routes: Edit."
fi
echo
echo "Deployed $version to $SITE"
