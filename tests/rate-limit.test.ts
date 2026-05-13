import { describe, it, expect } from 'vitest';
import { RateLimiter, perWindow } from '../src/lib/server/rate-limit';

describe('RateLimiter', () => {
	it('allows up to capacity then refuses', () => {
		const rl = new RateLimiter(3, 0);
		expect(rl.tryAcquire('a')).toBe(true);
		expect(rl.tryAcquire('a')).toBe(true);
		expect(rl.tryAcquire('a')).toBe(true);
		expect(rl.tryAcquire('a')).toBe(false);
	});

	it('refills over time', () => {
		const rl = perWindow(2, 1000); // 2 / sec
		const t0 = Date.now();
		expect(rl.tryAcquire('k', 1, t0)).toBe(true);
		expect(rl.tryAcquire('k', 1, t0)).toBe(true);
		expect(rl.tryAcquire('k', 1, t0)).toBe(false);
		expect(rl.tryAcquire('k', 1, t0 + 600)).toBe(true);
	});

	it('keys are independent', () => {
		const rl = new RateLimiter(1, 0);
		expect(rl.tryAcquire('a')).toBe(true);
		expect(rl.tryAcquire('b')).toBe(true);
		expect(rl.tryAcquire('a')).toBe(false);
	});
});
