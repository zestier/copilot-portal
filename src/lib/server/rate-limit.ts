// Lightweight in-process token-bucket rate limiter, keyed by string.
// Suitable for single-process deployment.

interface Bucket {
	tokens: number;
	last: number;
}

export class RateLimiter {
	private buckets = new Map<string, Bucket>();
	constructor(
		private capacity: number,
		private refillPerMs: number
	) {}

	tryAcquire(key: string, cost = 1, now = Date.now()): boolean {
		const b = this.buckets.get(key);
		const c = this.capacity;
		if (!b) {
			this.buckets.set(key, { tokens: c - cost, last: now });
			return cost <= c;
		}
		const elapsed = now - b.last;
		b.tokens = Math.min(c, b.tokens + elapsed * this.refillPerMs);
		b.last = now;
		if (b.tokens >= cost) {
			b.tokens -= cost;
			return true;
		}
		return false;
	}

	reset(key: string) {
		this.buckets.delete(key);
	}
}

// Convenience preset: N requests per windowMs.
export function perWindow(n: number, windowMs: number): RateLimiter {
	return new RateLimiter(n, n / windowMs);
}
