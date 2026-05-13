import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { exchangeCode, fetchProfile, isAllowed } from '$lib/server/auth/github';
import { upsertGithub } from '$lib/server/db/repos/users';
import { setGithubToken } from '$lib/server/db/repos/tokens';
import { issue } from '$lib/server/auth/session';
import { log } from '$lib/server/log';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const expectedState = cookies.get('oauth_state');
	cookies.delete('oauth_state', { path: '/' });

	if (!code || !state || !expectedState || state !== expectedState) {
		log.warn('oauth.state_mismatch');
		return new Response('Bad request', { status: 400 });
	}
	const redirectUri = `${url.origin}/auth/callback`;
	let token: string;
	let profile: Awaited<ReturnType<typeof fetchProfile>>;
	try {
		token = await exchangeCode(code, redirectUri);
		profile = await fetchProfile(token);
	} catch (e) {
		log.warn('oauth.failed', { err: String(e) });
		return new Response('Auth failed', { status: 502 });
	}
	if (!isAllowed(profile.login)) {
		log.warn('oauth.not_allowed', { login: profile.login });
		return new Response('Forbidden', { status: 403 });
	}
	const user = upsertGithub({
		githubLogin: profile.login,
		githubId: profile.id,
		displayName: profile.name,
		avatarUrl: profile.avatar_url
	});
	setGithubToken(user.id, token);
	issue(cookies, user.id, url.protocol === 'https:');
	throw redirect(303, '/');
};
