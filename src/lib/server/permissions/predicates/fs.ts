// Predicate for FsScope grants — `read` / `write` / `edit` requests.

import { isAbsolute, sep, relative } from 'node:path';
import type { FsScope, FsRule } from '../../../permissions/scope-types';
import { isPathInWorkspace, resolveWithParentFallback } from '../workspace';

export interface FsMatchContext {
	permissionKind: 'read' | 'write' | 'edit';
	target: string;
	workspaceRoot: string | null;
}

export function fsScopeMatches(scope: FsScope, ctx: FsMatchContext): boolean {
	if (scope.perms && scope.perms.length > 0 && !scope.perms.includes(ctx.permissionKind)) {
		return false;
	}
	return fsRuleMatches(scope.rule, ctx);
}

function fsRuleMatches(rule: FsRule, ctx: FsMatchContext): boolean {
	switch (rule.kind) {
		case 'exact':
			return ctx.target === rule.path;
		case 'workspace':
			return ctx.workspaceRoot ? isPathInWorkspace(ctx.target, ctx.workspaceRoot) : false;
		case 'workspace-glob': {
			if (!ctx.workspaceRoot) return false;
			if (!isPathInWorkspace(ctx.target, ctx.workspaceRoot)) return false;
			const rel = workspaceRelative(ctx.target, ctx.workspaceRoot);
			if (rel === null) return false;
			return tokenGlobMatches(rule.glob, rel);
		}
		case 'prefix':
			return prefixMatches(rule.path, ctx.target);
	}
}

/**
 * True when `target` is `prefix` itself or lives inside it, after
 * resolving symlinks on both sides (with parent-fallback for paths
 * that don't exist yet). Both arguments must be absolute; relative
 * inputs fail closed because the prefix wouldn't have a stable
 * meaning across working directories.
 */
function prefixMatches(prefix: string, target: string): boolean {
	if (!prefix || !target) return false;
	if (prefix.includes('\0') || target.includes('\0')) return false;
	if (!isAbsolute(prefix) || !isAbsolute(target)) return false;
	const resolvedPrefix = resolveWithParentFallback(prefix);
	const resolvedTarget = resolveWithParentFallback(target);
	if (resolvedPrefix === null || resolvedTarget === null) return false;
	if (resolvedTarget === resolvedPrefix) return true;
	const rel = relative(resolvedPrefix, resolvedTarget);
	if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
	return resolvedTarget.startsWith(resolvedPrefix + sep);
}

function workspaceRelative(target: string, root: string): string | null {
	let abs = target;
	if (!abs.startsWith('/')) abs = `${root.replace(/\/$/, '')}/${abs}`;
	const r = root.replace(/\/$/, '');
	if (abs === r) return '';
	if (!abs.startsWith(r + '/')) return null;
	return abs.slice(r.length + 1);
}

/**
 * Token-aware glob over `/`-separated paths:
 *   `*`  matches characters within a single segment
 *   `**` matches any number of full segments (including zero)
 * Everything else is literal.
 */
export function tokenGlobMatches(glob: string, path: string): boolean {
	return globToRegex(glob).test(path);
}

function globToRegex(glob: string): RegExp {
	let re = '^';
	let i = 0;
	while (i < glob.length) {
		const ch = glob[i];
		if (ch === '*') {
			if (glob[i + 1] === '*') {
				if (glob[i + 2] === '/') {
					re += '(?:.*/)?';
					i += 3;
				} else {
					re += '.*';
					i += 2;
				}
			} else {
				re += '[^/]*';
				i += 1;
			}
		} else {
			re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
			i += 1;
		}
	}
	re += '$';
	return new RegExp(re);
}
