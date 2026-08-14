import { handle } from '../src/backend/router';
import { ReconstructionSession } from '../src/backend/session-object';

export { ReconstructionSession };

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        return (await handle(request, env)) ?? env.ASSETS.fetch(request);
    }
} satisfies ExportedHandler<Env>;
