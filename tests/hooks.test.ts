import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Handle } from '@sveltejs/kit';
import { closeDb } from '../src/lib/server/db';
import { resetConfigForTests } from '../src/lib/server/config';

type HandleEvent = Parameters<Handle>[0]['event'];

/**
 * Exercises the SvelteKit `handle` hook directly. The auth gate is now
 * the single enforcement point for API authentication (per-handler
 * `if (!locals.userId) throw error(401)` checks were consolidated into
 * `requireUserId`, which is still defense-in-depth but trusts that the
 * gate has already rejected unauthenticated traffic). These tests guard
 * the invariant.
 */

function setupAuthedEnv() {
	const dir = mkdtempSync(join(tmpdir(), 'portal-hooks-test-'));
	process.env.DATA_DIR = dir;
	process.env.HOST = '127.0.0.1';
	process.env.AUTH_MODE = 'shared-secret';
	process.env.SHARED_SECRET = 'test-secret';
	process.env.SESSION_SECRET = randomBytes(48).toString('base64');
	process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
	delete process.env.I_KNOW_THIS_IS_LOCAL;
	delete process.env.TUNNEL_HOST;
	resetConfigForTests();
	closeDb();
	return dir;
}

function makeEvent(opts: { path: string; method?: string; origin?: string }): HandleEvent {
	const url = new URL(`http://127.0.0.1${opts.path}`);
	const headers = new Headers();
	if (opts.origin) headers.set('origin', opts.origin);
	const request = new Request(url, {
		method: opts.method ?? 'GET',
		headers
	});
	// Cast through unknown — we only populate the fields the `handle` hook
	// actually reads. The full RequestEvent has many runtime-only fields
	// (fetch, tracing, isRemoteRequest, etc.) we don't need here.
	return {
		url,
		request,
		cookies: {
			get: () => undefined,
			getAll: () => [],
			set: () => {},
			delete: () => {},
			serialize: () => ''
		},
		locals: {} as App.Locals,
		getClientAddress: () => '127.0.0.1',
		params: {},
		route: { id: null },
		setHeaders: () => {},
		platform: undefined,
		isDataRequest: false,
		isSubRequest: false
	} as unknown as HandleEvent;
}

async function loadHandle() {
	// Lazy import: `hooks.server.ts` runs `boot()` at module load, which
	// calls `loadConfig()`. Env must be set first, so we can't import at
	// the top of this file.
	const mod = await import('../src/hooks.server');
	return mod.handle;
}

describe('hooks auth gate', () => {
	beforeEach(() => {
		setupAuthedEnv();
	});

	it('returns 401 for unauthenticated /api/* requests', async () => {
		const handle = await loadHandle();
		const event = makeEvent({ path: '/api/conversations' });
		const res = await handle({
			event,
			resolve: async () => new Response('should not reach handler', { status: 200 })
		});
		expect(res.status).toBe(401);
	});

	it('redirects unauthenticated page requests to /login', async () => {
		const handle = await loadHandle();
		const event = makeEvent({ path: '/' });
		const res = await handle({
			event,
			resolve: async () => new Response('should not reach handler', { status: 200 })
		});
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/login');
	});

	it('allows /api/health without auth', async () => {
		const handle = await loadHandle();
		const event = makeEvent({ path: '/api/health' });
		const res = await handle({
			event,
			resolve: async () => new Response('ok', { status: 200 })
		});
		expect(res.status).toBe(200);
	});

	it('allows /login without auth', async () => {
		const handle = await loadHandle();
		const event = makeEvent({ path: '/login' });
		const res = await handle({
			event,
			resolve: async () => new Response('login page', { status: 200 })
		});
		expect(res.status).toBe(200);
	});

	it('blocks cross-origin mutating /api/* even when authenticated', async () => {
		// With no session cookie the request is unauthenticated, but the
		// auth gate runs before the origin check, so we'd see 401 here. To
		// exercise the origin gate we need AUTH_MODE=none. Use a separate
		// env scope.
		const dir = mkdtempSync(join(tmpdir(), 'portal-hooks-test-'));
		process.env.DATA_DIR = dir;
		process.env.HOST = '127.0.0.1';
		process.env.AUTH_MODE = 'none';
		process.env.I_KNOW_THIS_IS_LOCAL = '1';
		delete process.env.SESSION_SECRET;
		delete process.env.SHARED_SECRET;
		delete process.env.TUNNEL_HOST;
		resetConfigForTests();
		closeDb();

		const handle = await loadHandle();
		const event = makeEvent({
			path: '/api/conversations',
			method: 'POST',
			origin: 'https://evil.example.com'
		});
		const res = await handle({
			event,
			resolve: async () => new Response('should not reach handler', { status: 200 })
		});
		expect(res.status).toBe(403);
	});
});
