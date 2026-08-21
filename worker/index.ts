import { handle } from '../src/backend/router';
import { ReconstructionSession } from '../src/backend/session-object';

export { ReconstructionSession };

export default {
    async fetch(request, env) {
        return (await handle(request, env)) ?? env.ASSETS.fetch(request);
    }
} satisfies ExportedHandler<Env>;
