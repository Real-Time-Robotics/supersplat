# SuperSplat × Genesis Point

This is the [Real-Time-Robotics fork of SuperSplat](https://github.com/Real-Time-Robotics/supersplat).
It adds a Reconstruction panel that turns a folder or a selection of photos into a
Gaussian Splat through the Genesis Point TypeScript SDK, then opens the resulting PLY
model directly in SuperSplat.

The original editor and its Gaussian Splat inspection and editing tools come from
[playcanvas/supersplat](https://github.com/playcanvas/supersplat).

## Local setup

The `reconstruction` and `supersplat` repositories must be cloned next to each other.
Node.js 20.19 or newer is required.

```powershell
git clone https://github.com/Real-Time-Robotics/reconstruction.git
git clone https://github.com/Real-Time-Robotics/supersplat.git

cd reconstruction\sdk\typescript
npm install

cd ..\..\..\supersplat
npm install
Copy-Item .env.example .env.local
```

`.env.local` only configures the optional Genesis base URL and local port. User
credentials are requested inside the Reconstruction panel and are not read from the
environment.

Build and run the local app:

```powershell
npm run build
npm run serve
```

Open [http://localhost:3000](http://localhost:3000). For development with automatic
browser-bundle rebuilds, run `npm run sdk:build` once and then `npm run develop`.

## Usage

1. Select the orange Reconstruction icon in the right toolbar.
2. Log in, register, or enter an existing Genesis API key without leaving SuperSplat.
3. Choose an image folder, select multiple images, or drop the images into the panel.
4. Add credits from the panel if the quoted balance is insufficient.
5. Select **Tạo Gaussian Splat** and follow the upload and reconstruction progress.
6. When processing finishes, the primary PLY artifact opens automatically in SuperSplat.

The proxy stores each API key only in an in-memory, HttpOnly-cookie-backed server session.
Sessions are forgotten when the server restarts or when the user selects **Forget on this
device**. Login and registration rotate a dedicated `SuperSplat Reconstruction` API key
and show the new value once so it can be copied.
