import { redirect } from '@sveltejs/kit';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { PageServerLoad, Actions } from './$types';
import { loadConfig } from '$lib/server/config';
import { authorizeUrl } from '$lib/server/auth/github';
import { issue } from '$lib/server/auth/session';

function sharedSecretMatches(input: string, expected: string): boolean {
	const inputBytes = Buffer.from(input);
	const expectedBytes = Buffer.from(expected);
	return inputBytes.length === expectedBytes.length && timingSafeEqual(inputBytes, expectedBytes);
}

export const load: PageServerLoad = ({ locals, cookies, url }) => {
	if (locals.userId) throw redirect(302, '/');
	const cfg = loadConfig();
	if (cfg.AUTH_MODE === 'github') {
		const state = randomBytes(16).toString('base64url');
		cookies.set('oauth_state', state, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: url.protocol === 'https:',
			maxAge: 600
		});
		const redirectUri = `${url.origin}/auth/callback`;
		return { mode: 'github' as const, authorizeUrl: authorizeUrl(state, redirectUri) };
	}
	if (cfg.AUTH_MODE === 'shared-secret') {
		return { mode: 'shared-secret' as const };
	}
	return { mode: 'none' as const };
};

export const actions: Actions = {
	default: async ({ request, cookies, url, locals }) => {
		const cfg = loadConfig();
		if (cfg.AUTH_MODE !== 'shared-secret') {
			return { ok: false, error: 'Shared-secret login is disabled' };
		}
		const data = await request.formData();
		const secret = String(data.get('secret') ?? '');
		if (!secret || !cfg.SHARED_SECRET || !sharedSecretMatches(secret, cfg.SHARED_SECRET)) {
			return { ok: false, error: 'Invalid secret' };
		}
		// Use the local user as the principal in shared-secret mode.
		const { ensureLocalUser } = await import('$lib/server/db/repos/users');
		const user = ensureLocalUser();
		locals.userId = user.id;
		issue(cookies, user.id, url.protocol === 'https:');
		throw redirect(303, '/');
	}
};
