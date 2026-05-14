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
	const userSettings = settings.get(userId) ?? settings.defaults();
	const model = body.model ?? userSettings.defaultModel ?? cfg.DEFAULT_MODEL;

	const id = convs.newId();
	let workdir: string;
	if (body.workdir) {
		const res = resolveAndValidate(body.workdir);
		if (!res.ok) throw error(400, res.reason);
		workdir = res.path;
	} else {
		workdir = defaultWorkdirFor(id);
	}

	const conv = convs.create(userId, { id, title: body.title, workdir, model });
	return json({ ok: true, conversation: conv }, { status: 201 });
};
