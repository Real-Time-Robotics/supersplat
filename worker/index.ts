import { type Env, handle } from '../src/backend/router';

type WorkerEnv = Env & { ASSETS: { fetch: (request: Request) => Promise<Response> } };

export default {
    async fetch(request: Request, env: WorkerEnv): Promise<Response> {
        return (await handle(request, env)) ?? env.ASSETS.fetch(request);
    }
};
