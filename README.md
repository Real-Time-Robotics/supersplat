# SuperSplat x Genesis Point

RTRobotics' fork of [PlayCanvas SuperSplat](https://github.com/playcanvas/supersplat),
with photo reconstruction through the Genesis Point SDK.

The Reconstruction panel uploads or reuses datasets, follows processing and opens
Gaussian splats or textured meshes directly in the editor. The original inspection
and editing tools remain available.

| Component | Responsibility |
| --- | --- |
| [src](src/) | Editor and reconstruction interface. |
| [server.mjs](server.mjs) | Local server and authentication boundary. |
| [Cloudflare configuration](wrangler.jsonc) | Hosted assets and durable sessions. |
| [scripts](scripts/) | Deployment and regression checks. |

[Operations](OPERATIONS.md) | [Project commands](package.json) | [License](LICENSE)
