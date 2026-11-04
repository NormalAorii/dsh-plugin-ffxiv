/** Global Universalis request throttle (serialized, minimum interval per request). @module dsh-plugin-ffxiv/core/throttle */
/** Serialized rate limiter: every queued task runs at least `minIntervalMs` after the previous one. */
export class RateLimiter {
    minIntervalMs;
    tail = Promise.resolve();
    last = 0;
    constructor(minIntervalMs = 60) {
        this.minIntervalMs = minIntervalMs;
    }
    /** Queue one task behind the throttle and resolve with its result. */
    schedule(task) {
        const run = this.tail.then(async () => {
            const wait = this.last + this.minIntervalMs - Date.now();
            if (wait > 0)
                await new Promise((resolve) => setTimeout(resolve, wait));
            this.last = Date.now();
            return task();
        });
        this.tail = run.then(() => undefined, () => undefined);
        return run;
    }
}
/** Shared limiter for every Universalis call (≈16 req/s, safely under the documented 25 req/s). */
export const universalisLimiter = new RateLimiter(60);
