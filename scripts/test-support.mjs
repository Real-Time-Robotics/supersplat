import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';

const listenOnRandomPort = async (server) => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
};

const sendJson = (res, status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
};

const waitForServer = async (url, child) => {
    for (let attempt = 0; attempt < 50; attempt++) {
        if (child.exitCode != null) throw new Error(`SuperSplat server exited with ${child.exitCode}`);
        try {
            const response = await fetch(url);
            if (response.status === 401) return;
        } catch {
            // The listener may not be ready yet.
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for SuperSplat server.');
};

const startApp = async (context, gatewayPort) => {
    const probe = createServer();
    const appPort = await listenOnRandomPort(probe);
    await new Promise(resolve => probe.close(resolve));
    const child = spawn(process.execPath, ['server.mjs'], {
        cwd: new URL('..', import.meta.url),
        env: {
            ...process.env,
            PORT: String(appPort),
            GENESIS_BASE_URL: `http://127.0.0.1:${gatewayPort}`
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    context.after(() => child.kill('SIGKILL'));
    const appOrigin = `http://127.0.0.1:${appPort}`;
    await waitForServer(`${appOrigin}/api/reconstruction/session`, child);
    return appOrigin;
};

/** Sign in with an API key and return the cookie pair for subsequent requests. */
const signInWithApiKey = async (appOrigin, apiKey = 'gp_live_test') => {
    const response = await fetch(`${appOrigin}/api/reconstruction/session/api-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey })
    });
    if (response.status !== 200) throw new Error(`sign-in returned ${response.status}`);
    return response.headers.getSetCookie()[0].split(';')[0];
};

export { listenOnRandomPort, sendJson, signInWithApiKey, startApp, waitForServer };
