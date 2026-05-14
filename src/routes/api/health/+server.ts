import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';

export const GET: RequestHandler = () => {
	try {
		const r = getDb().prepare('SELECT 1 as ok').get() as { ok: number };
		if (r.ok !== 1) throw new Error('db check failed');
		return json({ ok: true });
	} catch (e) {
		return json({ ok: false, error: String(e) }, { status: 503 });
	}
};
