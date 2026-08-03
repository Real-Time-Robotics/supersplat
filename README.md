# SuperSplat × Genesis Point

This is the [Real-Time-Robotics fork of SuperSplat](https://github.com/Real-Time-Robotics/supersplat).
It adds a Reconstruction panel that turns a folder or a selection of photos into either
a Gaussian Splat or a textured photogrammetry mesh through the Genesis Point TypeScript
SDK, then opens the primary PLY or GLB model directly in SuperSplat.

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
3. Choose **3D Gaussian Splatting** or **Photogrammetry**.
4. Choose an image folder, select multiple images, drop images into the panel, or select
   **Use dataset** under **Recent models** to reconstruct existing source images without
   uploading them again.
5. Add credits from the panel if the quoted balance is insufficient.
6. Start reconstruction and follow the shared stage/in-stage progress display.
7. When processing finishes, the primary PLY or GLB artifact opens in SuperSplat.

The Photogrammetry card extends the Standard preset with the SfM front-half needed for
direct image uploads. It requires EXIF GPS in at least three source photos and produces
the preset's textured GLB, orthophoto, and DSM deliverables.

The proxy stores each API key only in an in-memory, HttpOnly-cookie-backed server session.
Sessions are forgotten when the server restarts or when the user selects **Forget on this
device**. Login and registration rotate a dedicated `SuperSplat Reconstruction` API key
and show the new value once so it can be copied.
