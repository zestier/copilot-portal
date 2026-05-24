import { redirect, fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { PageServerLoad, Actions } from './$types';
import * as settings from '$lib/server/db/repos/settings';
import {
	fetchAuthStatus,
	fetchModels,
	getDefaultProviderId,
	listProviders
} from '$lib/server/providers';
import {
	loadProviderStatus,
	shouldProbeProviderStatus,
	type ProviderStatusSnapshot
} from '$lib/server/providers/status';
import { providerAuthToken } from '$lib/server/providers/auth';
import { loadConfig } from '$lib/server/config';
import { getDeployMetadata } from '$lib/server/deploy';
import { log } from '$lib/server/log';
import {
	normalizeBackendProvider,
	BACKEND_PROVIDER_IDS,
	type PermissionPolicy,
	type SessionMode,
	type UserSettings
} from '$lib/types';
import { GrantInputSchema, permissionKindForTool } from '$lib/permissions/scope-schema';
import { stableScopeKey } from '$lib/permissions/scope-codec';
import { defaultSeedGrants, ensureSeedGrantsForUser } from '$lib/server/permissions/seed-grants';
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.userId) throw redirect(302, '/login');
	const userId = locals.userId;
	const cfg = loadConfig();
	const currentSettings = settings.get(userId) ?? settings.defaults();
	const defaultProvider = currentSettings.defaultProvider;

	// Garbage-collect expired grants on load so the management table
	// doesn't show TTL'd rows the matcher is already ignoring.
	const purged = settings.pruneExpiredGrants();
	if (purged > 0) log.info('settings.grants_pruned', { count: purged });

	const providers = await Promise.all(
		listProviders().map(async (provider): Promise<ProviderStatusSnapshot> => {
			try {
				return await loadProviderStatus(provider, {
					userId,
					providerAuthToken: shouldProbeProviderStatus(provider, defaultProvider)
						? providerAuthToken(provider.id, userId)
						: undefined,
					defaultProvider,
					loader: { fetchAuthStatus, fetchModels }
				});
			} catch (e) {
				log.warn('settings.provider_status_failed', { provider: provider.id, err: String(e) });
				return {
					id: provider.id,
					displayName: provider.displayName,
					ui: provider.ui,
					auth: { isAuthenticated: false, statusMessage: String(e) },
					models: [],
					capabilities: provider.capabilities,
					statusChecked: true,
					error: e instanceof Error ? e.message : String(e)
				};
			}
		})
	);
	const defaultProviderStatus =
		providers.find((provider) => provider.id === defaultProvider) ?? providers[0];

	return {
		settings: currentSettings,
		defaultProvider: getDefaultProviderId(),
		providers,
		defaultProviderStatus,
		recentDecisions: settings.listRecentDecisionsForUser(userId, 25),
		grants: markSeedGrants(settings.listGrantsForUser(userId)),
		enableRedeploy: cfg.ENABLE_REDEPLOY,
		deploy: getDeployMetadata()
	};
};

const SaveSchema = z.object({
	defaultProvider: z.enum(BACKEND_PROVIDER_IDS),
	defaultModel: z.string().optional(),
	defaultWorkdir: z.string().optional(),
	defaultConversationMode: z.enum(['interactive', 'plan', 'autopilot', 'best-effort']),
	defaultPolicy: z.enum(['prompt', 'allow-all', 'deny-all']),
	theme: z.enum(['dark', 'light', 'system'])
});

export const actions: Actions = {
	save: async ({ request, locals }) => {
		if (!locals.userId) return { ok: false, error: 'Not authenticated', formId: 'save' };
		const data = await request.formData();
		const parsed = SaveSchema.safeParse({
			defaultModel: (data.get('defaultModel') as string) || undefined,
			defaultProvider: data.get('defaultProvider'),
			defaultWorkdir: (data.get('defaultWorkdir') as string) || undefined,
			defaultConversationMode: data.get('defaultConversationMode'),
			defaultPolicy: data.get('defaultPolicy'),
			theme: data.get('theme')
		});
		if (!parsed.success) {
			return {
				ok: false,
				error: parsed.error.issues[0]?.message ?? 'Invalid settings',
				formId: 'save'
			};
		}
		const next: UserSettings = {
			defaultProvider: normalizeBackendProvider(parsed.data.defaultProvider),
			defaultModel: parsed.data.defaultModel ?? null,
			defaultWorkdir: parsed.data.defaultWorkdir ?? null,
			defaultConversationMode: parsed.data.defaultConversationMode as SessionMode,
			defaultPolicy: parsed.data.defaultPolicy as PermissionPolicy,
			theme: parsed.data.theme
		};
		settings.save(locals.userId, next);
		return { ok: true, formId: 'save' };
	},
	revokeGrant: async ({ request, locals }) => {
		if (!locals.userId)
			return fail(401, { ok: false, error: 'Not authenticated', formId: 'revokeGrant' });
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!Number.isInteger(id) || id <= 0) {
			return fail(400, { ok: false, error: 'Invalid grant id', formId: 'revokeGrant' });
		}
		const removed = settings.revokeGrant(locals.userId, id);
		if (!removed) return fail(404, { ok: false, error: 'Grant not found', formId: 'revokeGrant' });
		log.info('settings.grant_revoked', { userId: locals.userId, id });
		return { ok: true, formId: 'revokeGrant' };
	},
	revokeAllGrants: async ({ locals }) => {
		if (!locals.userId) {
			return fail(401, { ok: false, error: 'Not authenticated', formId: 'revokeAllGrants' });
		}
		const removed = settings.revokeAllGrantsForUser(locals.userId);
		log.info('settings.grants_revoked_all', { userId: locals.userId, count: removed });
		return { ok: true, removed, formId: 'revokeAllGrants' };
	},

	/**
	 * Re-install any default seed grants that aren't already present for
	 * this user. Idempotent: seeds the user has manually deleted will
	 * come back, seeds they already have are skipped. Lets a user
	 * recover after "Revoke all grants", and lets existing users
	 * back-fill any new seeds shipped after their account was created.
	 */
	restoreSeedGrants: async ({ locals }) => {
		if (!locals.userId) {
			return fail(401, { ok: false, error: 'Not authenticated', formId: 'restoreSeedGrants' });
		}
		const inserted = ensureSeedGrantsForUser(locals.userId);
		log.info('settings.seed_grants_restored', { userId: locals.userId, inserted });
		return { ok: true, inserted, formId: 'restoreSeedGrants' };
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
		const scopeKey = stableScopeKey(input.scope);
		const existing = settings.listGrantsForUser(locals.userId);
		const duplicate = existing.find(
			(g) =>
				g.conversationId === null &&
				g.tool === tool &&
				g.permissionKind === permissionKind &&
				g.scope !== null &&
				stableScopeKey(g.scope) === scopeKey &&
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
			expiresAt: input.expiresAt,
			denyReason: input.denyReason
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
			expiresAt: input.expiresAt,
			denyReason: input.denyReason
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

	const denyReasonRaw = data.get('denyReason');
	const denyReason = typeof denyReasonRaw === 'string' ? denyReasonRaw : null;

	const parsed = GrantInputSchema.safeParse({
		tool: data.get('tool'),
		decision: data.get('decision'),
		scope,
		expiresAt,
		denyReason
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

function markSeedGrants(grants: settings.GrantSummary[]) {
	const seedKeys = new Set(
		defaultSeedGrants().map((seed) =>
			defaultSeedGrantKey(seed.tool, seed.permissionKind, seed.scope, seed.decision ?? 'allow')
		)
	);

	return grants.map((grant) => ({
		...grant,
		isSeedGrant:
			grant.conversationId === null &&
			grant.scope !== null &&
			seedKeys.has(
				defaultSeedGrantKey(grant.tool, grant.permissionKind, grant.scope, grant.decision)
			)
	}));
}

function defaultSeedGrantKey(
	tool: string,
	permissionKind: string | null,
	scope: import('$lib/permissions/scope-types').GrantScope,
	decision: string
) {
	return `${tool}\u0000${permissionKind ?? ''}\u0000${decision}\u0000${stableScopeKey(scope)}`;
}
