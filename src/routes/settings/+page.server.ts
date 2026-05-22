import { redirect, fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { PageServerLoad, Actions } from './$types';
import * as settings from '$lib/server/db/repos/settings';
import * as tokens from '$lib/server/db/repos/tokens';
import { fetchAuthStatus, fetchModels } from '$lib/server/copilot/bridge';
import { loadConfig } from '$lib/server/config';
import { log } from '$lib/server/log';
import type { PermissionPolicy, UserSettings } from '$lib/types';
import { GrantInputSchema, permissionKindForTool } from '$lib/permissions/scope-schema';
import { encodeScope } from '$lib/permissions/scope-codec';
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.userId) throw redirect(302, '/login');
	const cfg = loadConfig();
	const authToken = tokens.getGithubToken(locals.userId) ?? cfg.COPILOT_GITHUB_TOKEN ?? undefined;

	// Garbage-collect expired grants on load so the management table
	// doesn't show TTL'd rows the matcher is already ignoring.
	const purged = settings.pruneExpiredGrants();
	if (purged > 0) log.info('settings.grants_pruned', { count: purged });

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
		recentDecisions: settings.listRecentDecisionsForUser(locals.userId, 25),
		grants: settings.listGrantsForUser(locals.userId),
		enableRedeploy: cfg.ENABLE_REDEPLOY
	};
};

const SaveSchema = z.object({
	defaultModel: z.string().optional(),
	defaultWorkdir: z.string().optional(),
	defaultPolicy: z.enum(['prompt', 'allow-all', 'deny-all']),
	theme: z.enum(['dark', 'light', 'system'])
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
	},
	revokeGrant: async ({ request, locals }) => {
		if (!locals.userId) return fail(401, { ok: false, error: 'Not authenticated' });
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!Number.isInteger(id) || id <= 0) {
			return fail(400, { ok: false, error: 'Invalid grant id' });
		}
		const removed = settings.revokeGrant(locals.userId, id);
		if (!removed) return fail(404, { ok: false, error: 'Grant not found' });
		log.info('settings.grant_revoked', { userId: locals.userId, id });
		return { ok: true };
	},
	revokeAllGrants: async ({ locals }) => {
		if (!locals.userId) return fail(401, { ok: false, error: 'Not authenticated' });
		const removed = settings.revokeAllGrantsForUser(locals.userId);
		log.info('settings.grants_revoked_all', { userId: locals.userId, count: removed });
		return { ok: true, removed };
	},

	/**
	 * Author a new user-global grant from the Settings form. The dialog
	 * still owns conversation-scoped + interactive-prompt grant creation;
	 * this action exists to cover the long tail of structured scopes
	 * (shell `workspace-paths`, fs `prefix`, url `host-suffix`, etc.) that
	 * the dialog has no UI for.
	 */
	createGrant: async ({ request, locals }) => {
		if (!locals.userId) return fail(401, { ok: false, error: 'Not authenticated' });
		const data = await request.formData();

		const parsedInput = parseGrantFormData(data, 'createGrant');
		if (!parsedInput.ok) return parsedInput.failure;
		const { input } = parsedInput;

		// Dedup against existing user-global grants with identical
		// (tool, kind, scope_json). Mirrors `ensureSeedGrantsForUser`.
		const tool = input.tool;
		const permissionKind = permissionKindForTool(tool);
		const encoded = encodeScope(input.scope);
		const existing = settings.listGrantsForUser(locals.userId);
		const duplicate = existing.find(
			(g) =>
				g.conversationId === null &&
				g.tool === tool &&
				g.permissionKind === permissionKind &&
				g.scope !== null &&
				encodeScope(g.scope) === encoded &&
				g.decision === input.decision
		);
		if (duplicate) {
			return { ok: true, formId: 'createGrant', duplicate: true };
		}

		settings.addGrant({
			userId: locals.userId,
			conversationId: null,
			tool,
			permissionKind,
			scope: input.scope,
			decision: input.decision,
			expiresAt: input.expiresAt
		});
		log.info('settings.grant_created', {
			userId: locals.userId,
			tool,
			permissionKind,
			decision: input.decision,
			scopeKind: input.scope.kind
		});
		return { ok: true, formId: 'createGrant' };
	},

	/**
	 * Edit an existing grant in place. Preserves the row's
	 * `conversation_id` and `granted_at`; only the matchable fields
	 * (tool/kind/scope/decision/expiry) change. Used by the "Edit" button
	 * on each grant row.
	 */
	updateGrant: async ({ request, locals }) => {
		if (!locals.userId) return fail(401, { ok: false, error: 'Not authenticated' });
		const data = await request.formData();

		const id = Number(data.get('id'));
		if (!Number.isInteger(id) || id <= 0) {
			return fail(400, { ok: false, error: 'Invalid grant id', formId: 'updateGrant' });
		}

		const parsedInput = parseGrantFormData(data, 'updateGrant');
		if (!parsedInput.ok) return parsedInput.failure;
		const { input } = parsedInput;

		const tool = input.tool;
		const permissionKind = permissionKindForTool(tool);
		const updated = settings.updateGrant(locals.userId, id, {
			tool,
			permissionKind,
			scopePattern: null,
			scope: input.scope,
			decision: input.decision,
			expiresAt: input.expiresAt
		});
		if (!updated) {
			return fail(404, { ok: false, error: 'Grant not found', formId: 'updateGrant' });
		}
		log.info('settings.grant_updated', {
			userId: locals.userId,
			id,
			tool,
			permissionKind,
			decision: input.decision,
			scopeKind: input.scope.kind
		});
		return { ok: true, formId: 'updateGrant' };
	}
};

type ParseGrantResult =
	| { ok: true; input: import('$lib/permissions/scope-schema').GrantInput }
	| { ok: false; failure: ReturnType<typeof fail> };

function parseGrantFormData(data: FormData, formId: string): ParseGrantResult {
	let scope: unknown;
	const scopeJson = data.get('scopeJson');
	if (typeof scopeJson !== 'string' || scopeJson.length === 0) {
		return { ok: false, failure: fail(400, { ok: false, error: 'Missing scope payload', formId }) };
	}
	try {
		scope = JSON.parse(scopeJson);
	} catch {
		return {
			ok: false,
			failure: fail(400, { ok: false, error: 'Scope payload was not valid JSON', formId })
		};
	}

	const expiresRaw = data.get('expiresAt');
	const expiresAt =
		typeof expiresRaw === 'string' && expiresRaw.length > 0 ? Date.parse(expiresRaw) : null;
	if (expiresAt !== null && Number.isNaN(expiresAt)) {
		return { ok: false, failure: fail(400, { ok: false, error: 'Invalid expiry date', formId }) };
	}

	const parsed = GrantInputSchema.safeParse({
		tool: data.get('tool'),
		decision: data.get('decision'),
		scope,
		expiresAt
	});
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue?.path.length ? ` (${issue.path.join('.')})` : '';
		return {
			ok: false,
			failure: fail(400, {
				ok: false,
				error: `${issue?.message ?? 'Invalid grant'}${where}`,
				formId
			})
		};
	}
	return { ok: true, input: parsed.data };
}
