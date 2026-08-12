import { type Env, handle } from '../src/backend/router';
import { ReconstructionSession } from '../src/backend/session-object';

type WorkerEnv = Env & { ASSETS: { fetch: (request: Request) => Promise<Response> } };

export { ReconstructionSession };

export default {
    async fetch(request: Request, env: WorkerEnv): Promise<Response> {
        return (await handle(request, env)) ?? env.ASSETS.fetch(request);
    }
};
