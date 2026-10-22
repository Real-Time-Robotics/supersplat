# SuperSplat operations

## Local workstation

Build this fork on Windows. Clone `reconstruction` beside `supersplat`; the editor
uses its TypeScript SDK. Node requirements and scripts are in `package.json`.
Install the SDK dependencies, then the editor dependencies. Copy `.env.example` to
`.env.local` and configure the local server's `supersplat-web` OIDC secret.

`npm run build` builds the SDK and editor; `npm run serve` serves
`http://127.0.0.1:3000`. The exact loopback host is part of the registered callback.
For incremental builds, run `npm run sdk:build` once, then `npm run develop`.

## Sessions

The browser receives an opaque HttpOnly cookie. Cloudflare session Durable Objects
hold submitted API keys or OIDC tokens server-side, expire after seven days and erase
state on logout or cleanup. The local Node equivalent is in memory and resets on restart.
Keep `OIDC_CLIENT_SECRET` out of browser bundles and `wrangler.jsonc`.

## Releases

Run `npm run typecheck`, `npm run lint` and `npm run build` before release.
`scripts/deploy.sh` defines production preflight, versioning, release and smoke checks;
`npm run deploy:staging` selects the staging Worker.
Eyrie's `deploy/deploy.sh editor` injects OpenBao's `supersplat` folder as Worker secrets.
Deployment requires separate authorization.
