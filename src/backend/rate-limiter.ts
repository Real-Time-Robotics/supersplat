import { DurableObject } from 'cloudflare:workers';

type Window = { count: number; resetAt: number };

type Verdict = { allowed: boolean; retryAfter: number };

class RateLimiter extends DurableObject<Env> {
    async hit(limit: number, windowSeconds: number): Promise<Verdict> {
        const now = Date.now();
        const stored = await this.ctx.storage.get<Window>('window');
        const fresh = !stored || stored.resetAt <= now;
        const window = fresh ? { count: 0, resetAt: now + windowSeconds * 1000 } : stored;
        if (window.count >= limit) {
            return { allowed: false, retryAfter: Math.ceil((window.resetAt - now) / 1000) };
        }
        await this.ctx.storage.put('window', { count: window.count + 1, resetAt: window.resetAt });
        if (fresh) await this.ctx.storage.setAlarm(window.resetAt);
        return { allowed: true, retryAfter: 0 };
    }

    async alarm(): Promise<void> {
        const stored = await this.ctx.storage.get<Window>('window');
        if (stored && stored.resetAt > Date.now()) await this.ctx.storage.setAlarm(stored.resetAt);
        else await this.ctx.storage.deleteAll();
    }
}

export { RateLimiter };
