// Predicate for UrlScope grants — `url` permission requests.

import type { UrlScope } from '../../../permissions/scope-types';

export interface UrlMatchContext {
	url: string;
}

export function urlScopeMatches(scope: UrlScope, ctx: UrlMatchContext): boolean {
	const rule = scope.rule;
	switch (rule.kind) {
		case 'exact':
			return ctx.url === rule.url;
		case 'host': {
			const host = hostOf(ctx.url);
			return host !== null && host === rule.host;
		}
		case 'host-suffix': {
			const host = hostOf(ctx.url);
			if (host === null) return false;
			return host === rule.suffix || host.endsWith('.' + rule.suffix);
		}
	}
}

function hostOf(url: string): string | null {
	try {
		return new URL(url).host.toLowerCase();
	} catch {
		return null;
	}
}
