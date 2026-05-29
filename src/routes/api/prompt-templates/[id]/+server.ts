import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as promptTemplates from '$lib/server/db/repos/prompt-templates';
import { requireUserId } from '$lib/server/auth/require';
import { parseBody } from '$lib/server/validate';

export const GET: RequestHandler = ({ params, locals }) => {
	const userId = requireUserId(locals);
	const template = promptTemplates.get(params.id, userId);
	if (!template) throw error(404);
	return json({ template: { ...template, source: 'custom' } });
};

const PatchBody = z
	.object({
		title: z.string().trim().min(1).max(120).optional(),
		description: z.string().trim().max(500).optional(),
		prompt: z.string().trim().min(1).max(20_000).optional(),
		status: z.enum(['open', 'archived']).optional(),
		pinned: z.boolean().optional(),
		orderIndex: z.number().int().min(-1_000_000).max(1_000_000).optional()
	})
	.refine(
		(body) =>
			body.title !== undefined ||
			body.description !== undefined ||
			body.prompt !== undefined ||
			body.status !== undefined ||
			body.pinned !== undefined ||
			body.orderIndex !== undefined,
		{ message: 'No fields to update' }
	);

export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	const userId = requireUserId(locals);
	const body = await parseBody(request, PatchBody);
	const template = promptTemplates.update(params.id, userId, body);
	if (!template) throw error(404);
	return json({ ok: true, template: { ...template, source: 'custom' } });
};

export const DELETE: RequestHandler = ({ params, locals }) => {
	const userId = requireUserId(locals);
	const template = promptTemplates.archive(params.id, userId);
	if (!template) throw error(404);
	return json({ ok: true, template: { ...template, source: 'custom' } });
};
