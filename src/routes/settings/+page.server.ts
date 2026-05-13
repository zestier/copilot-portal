import { redirect } from '@sveltejs/kit';
import { z } from 'zod';
import type { PageServerLoad, Actions } from './$types';
import * as settings from '$lib/server/db/repos/settings';
import type { PermissionPolicy, UserSettings } from '$lib/types';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.userId) throw redirect(302, '/login');
	return { settings: settings.getOrDefault(locals.userId) };
};

const SaveSchema = z.object({
	defaultModel: z.string().optional(),
	defaultWorkdir: z.string().optional(),
	defaultPolicy: z.enum(['prompt', 'allow-readonly', 'allow-all', 'deny-all']),
	theme: z.enum(['dark', 'light'])
});

export const actions: Actions = {
	save: async ({ request, locals }) => {
		if (!locals.userId) return { ok: false };
		const data = await request.formData();
		const parsed = SaveSchema.parse({
			defaultModel: (data.get('defaultModel') as string) || undefined,
			defaultWorkdir: (data.get('defaultWorkdir') as string) || undefined,
			defaultPolicy: data.get('defaultPolicy'),
			theme: data.get('theme')
		});
		const next: UserSettings = {
			defaultModel: parsed.defaultModel ?? null,
			defaultWorkdir: parsed.defaultWorkdir ?? null,
			defaultPolicy: parsed.defaultPolicy as PermissionPolicy,
			theme: parsed.theme
		};
		settings.save(locals.userId, next);
		return { ok: true };
	}
};
