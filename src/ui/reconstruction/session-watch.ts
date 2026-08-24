type WatchDeps = {
    now?: () => number;
    setTimer?: (fn: () => unknown, ms: number) => number;
    clearTimer?: (handle: number) => void;
};

/**
 * Ends the session on its own deadline rather than waiting for the next thing the user
 * does to be refused.
 *
 * A background tab may throttle its timer and a sleeping laptop may skip it, so browser
 * wake events call `wake()` and re-read the clock instead of trusting the armed callback.
 */
class SessionWatch {
    readonly #onExpired: () => void;
    readonly #now: () => number;
    readonly #setTimer: (fn: () => unknown, ms: number) => number;
    readonly #clearTimer: (handle: number) => void;
    #deadline: number | null = null;
    #handle: number | null = null;

    constructor(onExpired: () => void, deps: WatchDeps = {}) {
        this.#onExpired = onExpired;
        this.#now = deps.now ?? Date.now;
        this.#setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number);
        this.#clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle));
    }

    /** Watch a session ending at `expiresAt`. No deadline (an older server) watches nothing. */
    arm(expiresAt: number | null | undefined): void {
        this.#deadline = typeof expiresAt === 'number' && Number.isFinite(expiresAt) ?
            expiresAt :
            null;
        this.#schedule();
    }

    disarm(): void {
        this.#deadline = null;
        this.#cancel();
    }

    /** Re-read the clock after the tab wakes, instead of trusting a timer that may not have run. */
    wake(): void {
        if (this.#deadline === null) return;
        if (this.#now() >= this.#deadline) {
            this.#expire();
            return;
        }
        this.#schedule();
    }

    #schedule(): void {
        this.#cancel();
        if (this.#deadline === null) return;
        const delay = Math.max(0, this.#deadline - this.#now());
        this.#handle = this.#setTimer(() => this.#tick(), delay);
    }

    #cancel(): void {
        if (this.#handle === null) return;
        this.#clearTimer(this.#handle);
        this.#handle = null;
    }

    #tick(): void {
        this.#handle = null;
        this.wake();
    }

    #expire(): void {
        this.disarm();
        this.#onExpired();
    }
}

export { SessionWatch };
