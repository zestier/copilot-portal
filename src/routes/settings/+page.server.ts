import { redirect } from '@sveltejs/kit';
import { z } from 'zod';
import type { PageServerLoad, Actions } from './$types';
import * as settings from '$lib/server/db/repos/settings';
import * as tokens from '$lib/server/db/repos/tokens';
import { fetchAuthStatus, fetchModels } from '$lib/server/copilot/bridge';
import { loadConfig } from '$lib/server/config';
import { log } from '$lib/server/log';
import type { PermissionPolicy, UserSettings } from '$lib/types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.userId) throw redirect(302, '/login');
	const cfg = loadConfig();
	const authToken = tokens.getGithubToken(locals.userId) ?? cfg.COPILOT_GITHUB_TOKEN ?? undefined;

	let copilot: {
		auth: { isAuthenticated: boolean; authType?: string; login?: string; statusMessage?: string };
		models: { id: string; name: string }[];
		error?: string;
	};
	try {
		const [auth, models] = await Promise.all([fetchAuthStatus(authToken), fetchModels(authToken)]);
		copilot = {
			auth: {
				isAuthenticated: auth.isAuthenticated,
				authType: auth.authType,
				login: auth.login,
				statusMessage: auth.statusMessage
			},
			models: models.map((m) => ({ id: m.id, name: m.name }))
		};
	} catch (e) {
		log.warn('settings.copilot_status_failed', { err: String(e) });
		copilot = {
			auth: { isAuthenticated: false, statusMessage: String(e) },
			models: [],
			error: e instanceof Error ? e.message : String(e)
		};
	}

	return {
		settings: settings.get(locals.userId) ?? settings.defaults(),
		copilot,
		enableRedeploy: cfg.ENABLE_REDEPLOY
	};
};

const SaveSchema = z.object({
	defaultModel: z.string().optional(),
	defaultWorkdir: z.string().optional(),
	defaultPolicy: z.enum(['prompt', 'allow-readonly', 'allow-all', 'deny-all']),
	theme: z.enum(['dark', 'light'])
});

export const actions: Actions = {
	save: async ({ request, locals }) => {
		if (!locals.userId) return { ok: false, error: 'Not authenticated' };
		const data = await request.formData();
		const parsed = SaveSchema.safeParse({
			defaultModel: (data.get('defaultModel') as string) || undefined,
			defaultWorkdir: (data.get('defaultWorkdir') as string) || undefined,
			defaultPolicy: data.get('defaultPolicy'),
			theme: data.get('theme')
		});
		if (!parsed.success) {
			return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid settings' };
		}
		const next: UserSettings = {
			defaultModel: parsed.data.defaultModel ?? null,
			defaultWorkdir: parsed.data.defaultWorkdir ?? null,
			defaultPolicy: parsed.data.defaultPolicy as PermissionPolicy,
			theme: parsed.data.theme
		};
		settings.save(locals.userId, next);
		return { ok: true };
	}
};
