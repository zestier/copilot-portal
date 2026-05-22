import type { GrantScope } from '$lib/permissions/scope-types';
import type { PageData } from './$types';

export type FormResult = {
	ok?: boolean;
	error?: string;
	formId?: string;
	duplicate?: boolean;
};

export type SettingsTab = 'general' | 'permissions' | 'activity' | 'update';

export type SettingsData = PageData['settings'];
export type CopilotStatus = PageData['copilot'];
export type PermissionGrant = PageData['grants'][number];
export type PermissionDecision = PageData['recentDecisions'][number];

export function formatContextWindow(tokens: number | undefined): string {
	if (!tokens || !Number.isFinite(tokens)) return 'context size unknown';
	if (tokens >= 1_000_000) {
		const m = tokens / 1_000_000;
		const str = m >= 10 ? m.toFixed(0) : m.toFixed(1).replace(/\.0$/, '');
		return `${str}M ctx`;
	}
	if (tokens >= 1_000) {
		return `${Math.round(tokens / 1_000)}K ctx`;
	}
	return `${tokens} ctx`;
}

export function authLabel(a: CopilotStatus['auth']): string {
	if (!a.isAuthenticated) return 'Not signed in';
	const who = a.login ? `@${a.login}` : 'signed in';
	const via = a.authType ? ` via ${a.authType}` : '';
	return `${who}${via}`;
}

export function formatTime(ms: number): string {
	try {
		return new Date(ms).toLocaleString();
	} catch {
		return String(ms);
	}
}

export function decisionLabel(d: PermissionDecision['decision']): string {
	switch (d) {
		case 'allow-once':
			return 'Allow once';
		case 'allow-always':
			return 'Allow always';
		case 'deny':
			return 'Deny';
		case 'deny-always':
			return 'Deny always';
		case 'auto-allow':
			return 'Auto-allow';
		case 'auto-deny':
			return 'Auto-deny';
	}
}

export function grantScopeLabel(g: {
	conversationId: string | null;
	conversationTitle: string | null;
}) {
	if (!g.conversationId) return 'Global';
	return g.conversationTitle ?? g.conversationId;
}

export function describeGrantScope(g: {
	scope: GrantScope | null;
	scopePattern: string | null;
}): string {
	const s = g.scope;
	if (s) {
		switch (s.kind) {
			case 'any':
				return '*';
			case 'shell':
				return `argv0=${s.rule.argv0}`;
			case 'url':
				switch (s.rule.kind) {
					case 'exact':
						return s.rule.url;
					case 'host':
						return `host=${s.rule.host}`;
					case 'host-suffix':
						return `*.${s.rule.suffix}`;
				}
				break;
			case 'fs': {
				const perms = s.perms && s.perms.length > 0 ? `[${s.perms.join('|')}] ` : '';
				switch (s.rule.kind) {
					case 'exact':
						return `${perms}${s.rule.path}`;
					case 'workspace':
						return `${perms}<workspace>`;
					case 'workspace-glob':
						return `${perms}<workspace>/${s.rule.glob}`;
					case 'prefix':
						return `${perms}${s.rule.path}/**`;
				}
			}
		}
	}
	return g.scopePattern ?? '*';
}

export function formatExpiry(ms: number | null): string {
	if (ms == null) return 'Never';
	const delta = ms - Date.now();
	if (delta <= 0) return 'expired';
	const mins = Math.round(delta / 60_000);
	if (mins < 60) return `in ${mins}m`;
	const hours = Math.round(mins / 60);
	if (hours < 48) return `in ${hours}h`;
	return `in ${Math.round(hours / 24)}d`;
}
