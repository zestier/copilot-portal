import { json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { listBuiltInPromptTemplates, type PromptTemplateListItem } from '$lib/prompt-templates';
import * as promptTemplates from '$lib/server/db/repos/prompt-templates';
import { requireUserId } from '$lib/server/auth/require';
import { parseBody } from '$lib/server/validate';

export const GET: RequestHandler = ({ locals }) => {
	const userId = requireUserId(locals);
	const builtInTemplates = listBuiltInPromptTemplates();
	const customTemplates = promptTemplates.list(userId).map(
		(template): PromptTemplateListItem => ({
			...template,
			source: 'custom'
		})
	);
	return json({
		builtInTemplates,
		customTemplates,
		templates: [...builtInTemplates, ...customTemplates]
	});
};

const CreateBody = z.object({
	title: z.string().trim().min(1).max(120),
	description: z.string().trim().max(500).optional(),
	prompt: z.string().trim().min(1).max(20_000),
	pinned: z.boolean().optional(),
	orderIndex: z.number().int().min(-1_000_000).max(1_000_000).optional()
});

export const POST: RequestHandler = async ({ locals, request }) => {
	const userId = requireUserId(locals);
	const body = await parseBody(request, CreateBody);
	const template = promptTemplates.create(userId, body);
	return json({ ok: true, template: { ...template, source: 'custom' } }, { status: 201 });
};
