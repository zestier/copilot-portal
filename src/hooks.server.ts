import type { Handle, HandleServerError } from '@sveltejs/kit';
import { loadConfig } from '$lib/server/config';
import { log } from '$lib/server/log';
import { getDb } from '$lib/server/db';
import * as users from '$lib/server/db/repos/users';
import { read as readSession, generateCsrfToken } from '$lib/server/auth/session';
import { perWindow } from '$lib/server/rate-limit';
import { apiErrorResponse } from '$lib/server/http';
import { startIdleReaper } from '$lib/server/copilot/pool';

// One-time bootstrap.
let booted = false;
function boot() {
	if (booted) return;
	booted = true;
	loadConfig(); // throws if invalid
	getDb(); // opens + migrates
	startIdleReaper();
	log.info('boot.ok');
}
boot();

const loginLimiter = perWindow(5, 15 * 60_000); // 5 / 15min per IP
const apiLimiter = perWindow(60, 60_000); // 60 / min per user

const PUBLIC_PATHS = new Set(['/login', '/auth/callback', '/api/health']);
const PUBLIC_PREFIXES = ['/_app/', '/favicon'];

function isPublic(pathname: string): boolean {
	if (PUBLIC_PATHS.has(pathname)) return true;
	return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

function clientIp(event: Parameters<Handle>[0]['event']): string {
	const xff = event.request.headers.get('x-forwarded-for');
	if (xff) return xff.split(',')[0].trim();
	return event.getClientAddress();
}

export const handle: Handle = async ({ event, resolve }) => {
	const cfg = loadConfig();
	const secure = event.url.protocol === 'https:';

	// Default locals
	event.locals.userId = null;
	event.locals.user = null;
	event.locals.csrfToken = generateCsrfToken();

	// AUTH_MODE=none: auto-login the local user.
	if (cfg.AUTH_MODE === 'none') {
		const u = users.ensureLocalUser();
		event.locals.userId = u.id;
		event.locals.user = u;
	} else {
		const claims = readSession(event.cookies, secure);
		if (claims) {
			const u = users.getById(claims.sub);
			if (u) {
				event.locals.userId = u.id;
				event.locals.user = u;
			}
		}
	}

	// Auth gate.
	const path = event.url.pathname;
	if (!isPublic(path) && !event.locals.userId) {
		if (path.startsWith('/api/')) {
			return apiErrorResponse(401, 'unauthorized');
		}
		return new Response(null, {
			status: 302,
			headers: { location: '/login' }
		});
	}

	// Origin check for mutating JSON API calls. Skipped when TUNNEL_HOST is
	// set because event.url.origin won't match what the browser sent. The
	// session cookie is SameSite=Lax which still blocks cross-site CSRF.
	if (!cfg.TUNNEL_HOST && path.startsWith('/api/') && event.request.method !== 'GET') {
		const origin = event.request.headers.get('origin');
		const referer = event.request.headers.get('referer');
		const expectedOrigin = event.url.origin;
		const ok =
			(origin && origin === expectedOrigin) ||
			(referer && referer.startsWith(expectedOrigin + '/'));
		if (!ok) {
			return apiErrorResponse(403, 'bad_origin');
		}
	}

	// Rate limit.
	if (path === '/login' && event.request.method === 'POST') {
		if (!loginLimiter.tryAcquire(`login:${clientIp(event)}`)) {
			return new Response('Too many requests', { status: 429 });
		}
	}
	if (path.startsWith('/api/') && event.locals.userId) {
		if (!apiLimiter.tryAcquire(`api:${event.locals.userId}`)) {
			return apiErrorResponse(429, 'rate_limited');
		}
	}

	const response = await resolve(event, {
		transformPageChunk: ({ html }) => html.replace('%csrf.token%', event.locals.csrfToken)
	});

	// Security headers.
	if (!response.headers.has('content-security-policy')) {
		response.headers.set(
			'content-security-policy',
			[
				"default-src 'self'",
				"script-src 'self' 'unsafe-inline'",
				"style-src 'self' 'unsafe-inline'",
				"connect-src 'self'",
				"img-src 'self' data: https://avatars.githubusercontent.com",
				"font-src 'self' data:",
				"frame-ancestors 'none'",
				"base-uri 'self'",
				"form-action 'self'"
			].join('; ')
		);
	}
	response.headers.set('x-content-type-options', 'nosniff');
	response.headers.set('referrer-policy', 'no-referrer');
	response.headers.set('x-frame-options', 'DENY');
	if (secure) {
		response.headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains');
	}

	return response;
};

export const handleError: HandleServerError = ({ error, event, status }) => {
	// 404s aren't server errors; don't spam the log with browser/extension
	// probes for /favicon.ico and friends.
	if (status === 404) {
		return { message: 'Not found', code: 'not_found' };
	}
	const id = Math.random().toString(36).slice(2, 10);
	log.error('unhandled', {
		id,
		path: event.url.pathname,
		err: error instanceof Error ? (error.stack ?? error.message) : String(error)
	});
	return { message: 'Internal server error', code: id };
};
