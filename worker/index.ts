import { RateLimiter } from '../src/backend/rate-limiter';
import { handle } from '../src/backend/router';
import { ReconstructionSession } from '../src/backend/session-object';

export { RateLimiter, ReconstructionSession };

export default {
    async fetch(request, env) {
        return (await handle(request, env)) ?? env.ASSETS.fetch(request);
    }
} satisfies ExportedHandler<Env>;
