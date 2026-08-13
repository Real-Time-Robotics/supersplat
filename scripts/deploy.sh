#!/usr/bin/env bash
# Ship the editor to Cloudflare Workers.
#   scripts/deploy.sh              # preflight -> gate -> bump patch -> build+deploy -> smoke
#   scripts/deploy.sh --no-bump    # same, keeping the current version
#
# Creds live in ~/.config/genesis/cloudflare.env (0600):
#   CLOUDFLARE_API_TOKEN=...     # Workers Scripts: Edit + zone Workers Routes: Edit
#   CLOUDFLARE_ACCOUNT_ID=...
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

CREDS="${CLOUDFLARE_ENV:-$HOME/.config/genesis/cloudflare.env}"
SITE="${SITE_URL:-https://editor.rtrobotics.com}"
WORKER="${WORKER_NAME:-supersplat-editor}"
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

deployment_id() {
    curl -sf -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
        "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER/deployments" |
        node -e 'let b = ""; process.stdin.on("data", c => b += c).on("end", () => {
            const d = JSON.parse(b).result?.deployments ?? [];
            // Picked by date, not by position: the API answers newest-first today,
            // but nothing in the response promises that.
            const newest = d.reduce((a, x) => (a && a.created_on > x.created_on ? a : x), null);
            process.stdout.write(newest?.id ?? "");
        })' 2>/dev/null || true
}

# Check if wrangler is available as devDependency
step "preflight"
[ -x node_modules/.bin/wrangler ] || {
    echo "ERROR: no node_modules/.bin/wrangler -- run npm install" >&2
    exit 1
}
node_modules/.bin/wrangler --version

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

if [ "$BUMP" = 1 ]; then
    step "bump patch"
    bumped_from="$(node -p 'require("./package.json").version')"
    npm version patch --no-git-tag-version
fi
version="$(node -p 'require("./package.json").version')"

step "deploy $version"
before="$(deployment_id)"
# prebuild bundles the linked Genesis SDK.
set +e
npm run deploy
deploy_rc=$?
set -e
after="$(deployment_id)"

if [ "$deploy_rc" != 0 ] && [ -n "$after" ] && [ "$after" = "$before" ]; then
    echo "FAIL: wrangler exited $deploy_rc and left deployment $after in place -- nothing was uploaded" >&2
    if [ "$BUMP" = 1 ]; then
        # Keeping the bump would walk the version one patch further from what is live on
        # every failed run.
        npm version "$bumped_from" --no-git-tag-version --allow-same-version >/dev/null
        echo "Reverted the bump to $bumped_from." >&2
    fi
    exit 1
fi
[ "$deploy_rc" = 0 ] || echo "WARN: wrangler exited $deploy_rc after uploading -- smoke decides" >&2

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
