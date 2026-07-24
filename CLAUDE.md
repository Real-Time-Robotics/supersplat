# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

This is the **Real-Time-Robotics fork of SuperSplat** — a browser-based 3D Gaussian Splat editor (from [playcanvas/supersplat](https://github.com/playcanvas/supersplat)). The fork adds a **Reconstruction panel** that turns a folder of photos into a Gaussian Splat via the Genesis Point TypeScript SDK, then opens the resulting PLY in the editor.

Two moving parts beyond upstream:
- `src/ui/reconstruction-panel.ts` — the client panel (upload progress, credit/checkout flow, SSE progress).
- `server.mjs` — an Express server that proxies to the Genesis Point SDK (`genesis-recon`) and also serves the built app.

## Repo layout requirement

The `reconstruction` repo must be cloned **next to** `supersplat` (`../reconstruction/sdk/typescript`). `genesis-recon` is a `file:` dependency pointing there, and `npm run build` runs `sdk:build` in that repo first. Node >= 20.19.

Genesis credentials live in `.env.local` (gitignored): `GENESIS_API_KEY`, optional `GENESIS_BASE_URL` (default `https://recons.rtrobotics.com`), `PORT`. Server exits on startup if the key is missing.

## Commands

```bash
npm run build          # rollup production build → dist/ (runs sdk:build first)
npm run serve          # run Express server (server.mjs) on :3000, serves dist/ + /api
npm run develop        # debug build: rollup watch + server concurrently (BUILD_TYPE=debug)
npm run watch          # rollup watch only
npm run lint           # eslint src
npm run lint:locales   # verify all static/locales/*.json match en.json keys/order
```

There is no unit test suite. `npm run develop` is the normal dev loop; open http://localhost:3000. `BUILD_TYPE` = `debug` | `profile` | `release` (default). Release strips `Debug.exec(...)` calls and terser-minifies. Rollup aliases `playcanvas` and `@playcanvas/pcui` to specific paths — the same pin is mirrored in `tsconfig.json` `paths` (needed when the SDK is npm-linked, otherwise two mismatched engine type identities appear).

## Architecture

**Event bus is the backbone.** `src/events.ts` (`Events extends EventHandler`) is the single object threaded through everything. Two patterns:
- `events.on(name, fn)` / `events.fire(name, ...)` — pub/sub for state changes.
- `events.function(name, fn)` / `events.invoke(name, ...)` — single-owner RPC-style calls (registering a duplicate name throws). E.g. `events.invoke('import', files)`, `events.invoke('scene.export', type)`.

Feature modules follow a `registerXxxEvents(events, ...)` convention and are wired up in `src/main.ts` (the boot sequence: localization → events object → UI → graphics device → `Scene` → tools → register-events → `scene.start()` → handle `?load=` params). `src/main.ts` is the source of truth for wiring order.

**Scene / Element model.** `src/scene.ts` owns the PlayCanvas app (`PCApp`), camera, grid, and a list of `Element`s (`src/element.ts`). `ElementType` = camera | model | splat | shadow | debug | other. Each `Element` has lifecycle hooks (`add`, `remove`, `onUpdate`, `onPreRender`, `serialize`, …). A loaded splat is a `Splat` element (`src/splat.ts`).

**Editing = commands + history.** Mutations are `EditOp` objects (`src/edit-ops.ts`) pushed through `events.fire('edit.add', op)` into `EditHistory` (`src/edit-history.ts`). All async splat work (GPU readbacks + history mutations) is serialized through a single shared `CommandQueue` (`src/command-queue.ts`), exposed as the `'queue'` event so ordering is preserved across consumers. Touch this queue, not ad-hoc promises, when adding async edits.

**GPU/data work** lives in `src/data-processor/` (bound calc, histogram, positions, selection-by-range, intersection) — mostly render-to-texture readback of splat state. Selection/transform **tools** are in `src/tools/`, registered on the `ToolManager` in `main.ts`.

**IO.** `src/io/` (read/write) plus `src/file-handler.ts` (registers `import`, `scene.export`, `scene.write`, etc.). Splat serialization: `src/splat-serialize.ts`. Formats go through `@playcanvas/splat-transform`. Note in `main.ts`: `WorkerQueue.maxWorkers = 0` — SOG writing runs inline because the worker.mjs isn't shipped (leaving the pool on causes a 404 → hang → empty export).

**UI** is built imperatively with `@playcanvas/pcui` components (not React), under `src/ui/`. Styles are SCSS in `src/ui/scss/`. Text is localized via i18next — add strings to every file in `static/locales/` (run `lint:locales` to check) and access with the `i18n` helper (`src/ui/localization.ts`).

## Server (`server.mjs`)

Single Express file. Routes under `/api/reconstruction/*`: health, credits, pricing, checkout (+ status polling), dataset quote/delete, image upload (multer, up to 2000 files → SSE `uploads/:id/events`), job create/status/cancel (+ SSE `jobs/:id/events`), and `jobs/:id/model` to fetch the result PLY. It thinly wraps the `genesis-recon` `Client`. Everything else falls through to static `dist/` + SPA `index.html`.

## Conventions

- ESLint uses `@playcanvas/eslint-config`; several strict TS rules are intentionally off (`no-explicit-any`, `no-unused-vars`, jsdoc requirements). Match existing style — the codebase leans on `any` at engine boundaries.
- `strictNullChecks` is **off**; don't assume non-null narrowing works.
- Fork-specific UI text is Vietnamese in places (e.g. "Tạo Gaussian Splat"); keep it consistent with the reconstruction panel.
