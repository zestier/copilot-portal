// Session cookie: HMAC-SHA256-signed compact JSON.
// Format: base64url(JSON({sub, iat, exp})).base64url(HMAC).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { loadConfig } from '../config';

const COOKIE_NAME = '__Host-portal_session';
const DEV_COOKIE_NAME = 'portal_session'; // when not over HTTPS, drop __Host-

interface Claims {
	sub: string;
	iat: number;
	exp: number;
}

function b64uEncode(buf: Buffer | string): string {
	const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8');
	return b.toString('base64url');
}
function b64uDecode(s: string): Buffer {
	return Buffer.from(s, 'base64url');
}

function getSecret(): Buffer {
	const cfg = loadConfig();
	if (cfg.AUTH_MODE === 'none') {
		// Stable but uniqueless; only used to sign the local-user cookie.
		return Buffer.from('local-dev-session-key-not-secure-do-not-expose');
	}
	if (!cfg.SESSION_SECRET) throw new Error('SESSION_SECRET not configured');
	return Buffer.from(cfg.SESSION_SECRET, 'utf8');
}

export function sign(claims: Claims): string {
	const payload = b64uEncode(JSON.stringify(claims));
	const sig = b64uEncode(createHmac('sha256', getSecret()).update(payload).digest());
	return `${payload}.${sig}`;
}

export function verify(token: string): Claims | null {
	const parts = token.split('.');
	if (parts.length !== 2) return null;
	const [payload, sig] = parts;
	const expected = createHmac('sha256', getSecret()).update(payload).digest();
	let provided: Buffer;
	try {
		provided = b64uDecode(sig);
	} catch {
		return null;
	}
	if (provided.length !== expected.length) return null;
	if (!timingSafeEqual(provided, expected)) return null;
	let claims: Claims;
	try {
		claims = JSON.parse(b64uDecode(payload).toString('utf8'));
	} catch {
		return null;
	}
	if (!claims || typeof claims.sub !== 'string') return null;
	if (typeof claims.exp !== 'number' || Date.now() / 1000 > claims.exp) return null;
	return claims;
}

function cookieName(secure: boolean): string {
	return secure ? COOKIE_NAME : DEV_COOKIE_NAME;
}

const THIRTY_DAYS = 60 * 60 * 24 * 30;

export function issue(cookies: Cookies, userId: string, secure = true): string {
	const now = Math.floor(Date.now() / 1000);
	const token = sign({ sub: userId, iat: now, exp: now + THIRTY_DAYS });
	cookies.set(cookieName(secure), token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure,
		maxAge: THIRTY_DAYS
	});
	return token;
}

export function clear(cookies: Cookies, secure = true) {
	cookies.delete(cookieName(secure), { path: '/' });
}

export function read(cookies: Cookies, secure = true): Claims | null {
	const v = cookies.get(cookieName(secure)) ?? cookies.get(cookieName(!secure));
	if (!v) return null;
	return verify(v);
}

export function generateCsrfToken(): string {
	return randomBytes(24).toString('base64url');
}
