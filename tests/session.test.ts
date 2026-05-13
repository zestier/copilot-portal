import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { resetConfigForTests } from '../src/lib/server/config';
import { sign, verify } from '../src/lib/server/auth/session';

describe('session signing', () => {
	beforeEach(() => {
		process.env.HOST = '127.0.0.1';
		process.env.AUTH_MODE = 'shared-secret';
		process.env.SHARED_SECRET = 'x';
		process.env.SESSION_SECRET = randomBytes(48).toString('base64');
		process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
		resetConfigForTests();
	});

	it('round-trips valid claims', () => {
		const now = Math.floor(Date.now() / 1000);
		const tok = sign({ sub: 'u1', iat: now, exp: now + 60 });
		expect(verify(tok)?.sub).toBe('u1');
	});

	it('rejects expired tokens', () => {
		const now = Math.floor(Date.now() / 1000);
		const tok = sign({ sub: 'u1', iat: now - 100, exp: now - 10 });
		expect(verify(tok)).toBeNull();
	});

	it('rejects tampered tokens', () => {
		const now = Math.floor(Date.now() / 1000);
		const tok = sign({ sub: 'u1', iat: now, exp: now + 60 });
		const [p, s] = tok.split('.');
		const bad = `${p}A.${s}`;
		expect(verify(bad)).toBeNull();
	});
});
