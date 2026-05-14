import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as settings from '$lib/server/db/repos/settings';
import { loadConfig } from '$lib/server/config';
import { defaultWorkdirFor, resolveAndValidate } from '$lib/server/workdir';
import { parseBody } from '$lib/server/validate';
import { requireUserId } from '$lib/server/auth/require';

export const GET: RequestHandler = ({ locals, url }) => {
	const userId = requireUserId(locals);
	const includeArchived = url.searchParams.get('archived') === '1';
	return json({ conversations: convs.list(userId, { includeArchived }) });
};

const CreateBody = z.object({
	title: z.string().min(1).max(200).default('New chat'),
	model: z.string().min(1).optional(),
	workdir: z.string().min(1).optional()
});

export const POST: RequestHandler = async ({ locals, request }) => {
	const userId = requireUserId(locals);
	const body = await parseBody(request, CreateBody);
	const cfg = loadConfig();
	const userSettings = settings.getOrDefault(userId);
	const model = body.model ?? userSettings.defaultModel ?? cfg.DEFAULT_MODEL;

	// First create the row so we can use its id for the default workdir.
	const placeholderWorkdir = body.workdir ?? '';
	const conv = convs.create(userId, {
		title: body.title,
		workdir: placeholderWorkdir,
		model
	});

	let workdir: string;
	if (body.workdir) {
		const res = resolveAndValidate(body.workdir);
		if (!res.ok) {
			convs.remove(conv.id, userId);
			throw error(400, res.reason);
		}
		workdir = res.path;
	} else {
		workdir = defaultWorkdirFor(conv.id);
	}
	// Update with real workdir.
	conv.workdir = workdir;
	// Direct write via repo's rename trick is overkill; do a raw update.
	const { getDb } = await import('$lib/server/db');
	getDb().prepare('UPDATE conversations SET workdir = ? WHERE id = ?').run(workdir, conv.id);

	return json({ conversation: conv }, { status: 201 });
};
