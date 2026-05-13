import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clear } from '$lib/server/auth/session';

export const POST: RequestHandler = ({ cookies, url }) => {
	clear(cookies, url.protocol === 'https:');
	throw redirect(303, '/login');
};
