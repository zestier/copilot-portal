import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { resetConfigForTests } from '../src/lib/server/config';
import { encrypt, decrypt, encryptString, decryptString } from '../src/lib/server/crypto';

describe('crypto', () => {
	beforeEach(() => {
		process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
		process.env.HOST = '127.0.0.1';
		process.env.AUTH_MODE = 'none';
		process.env.I_KNOW_THIS_IS_LOCAL = '1';
		resetConfigForTests();
	});

	it('round-trips strings', () => {
		const s = 'hello, world';
		expect(decryptString(encryptString(s))).toBe(s);
	});

	it('uses fresh nonce per encryption (ciphertexts differ)', () => {
		const a = encrypt('same');
		const b = encrypt('same');
		expect(Buffer.compare(a, b)).not.toBe(0);
		expect(decrypt(a).toString('utf8')).toBe('same');
		expect(decrypt(b).toString('utf8')).toBe('same');
	});

	it('rejects tampered ciphertext', () => {
		const ct = encrypt('secret');
		ct[ct.length - 1] ^= 0xff;
		expect(() => decrypt(ct)).toThrow();
	});
});
