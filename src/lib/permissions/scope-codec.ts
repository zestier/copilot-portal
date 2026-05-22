// JSON ↔ GrantScope codec with defensive validation.
//
// All grant rows are loaded through `decodeScope` (returns null on any
// malformed input); we never feed structurally invalid JSON to the
// matcher. New rows are serialized with `encodeScope` which guarantees a
// shape the codec will accept.

import type {
	GrantScope,
	ShellScope,
	ShellRule,
	FsScope,
	FsRule,
	UrlScope,
	UrlRule,
	PositionalsRule
} from './scope-types';

export function encodeScope(scope: GrantScope): string {
	return JSON.stringify(scope);
}

export function decodeScope(raw: string | null | undefined): GrantScope | null {
	if (raw == null || raw === '') return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	return validate(parsed);
}

function validate(v: unknown): GrantScope | null {
	if (!isObject(v)) return null;
	const kind = (v as { kind?: unknown }).kind;
	switch (kind) {
		case 'any':
			return { kind: 'any' };
		case 'shell':
			return validateShell(v);
		case 'fs':
			return validateFs(v);
		case 'url':
			return validateUrl(v);
		default:
			return null;
	}
}

function validateShell(v: Record<string, unknown>): ShellScope | null {
	const rule = isObject(v.rule) ? (v.rule as Record<string, unknown>) : null;
	if (!rule) return null;
	const argv0 = rule.argv0;
	if (typeof argv0 !== 'string' || argv0.length === 0) return null;
	if (argv0.includes('/') || argv0.startsWith('.')) return null;

	const out: ShellRule = { argv0 };

	if (rule.subcommands !== undefined) {
		if (!Array.isArray(rule.subcommands)) return null;
		const subs: string[] = [];
		for (const s of rule.subcommands) {
			if (typeof s !== 'string' || s.length === 0) return null;
			subs.push(s);
		}
		out.subcommands = subs;
	}

	if (rule.flags !== undefined) {
		if (!isObject(rule.flags)) return null;
		const f = rule.flags as Record<string, unknown>;
		const flags: NonNullable<ShellRule['flags']> = {};
		if (f.allow !== undefined) {
			const list = asStringList(f.allow);
			if (list === null) return null;
			flags.allow = list;
		}
		if (f.deny !== undefined) {
			const list = asStringList(f.deny);
			if (list === null) return null;
			flags.deny = list;
		}
		out.flags = flags;
	}

	if (rule.positionals !== undefined) {
		const p = validatePositionals(rule.positionals);
		if (!p) return null;
		out.positionals = p;
	}

	return { kind: 'shell', rule: out };
}

function validatePositionals(v: unknown): PositionalsRule | null {
	if (!isObject(v)) return null;
	const kind = (v as { kind?: unknown }).kind;
	if (kind === 'none' || kind === 'any' || kind === 'workspace-paths') {
		return { kind } as PositionalsRule;
	}
	return null;
}

function validateFs(v: Record<string, unknown>): FsScope | null {
	const rule = isObject(v.rule) ? (v.rule as Record<string, unknown>) : null;
	if (!rule) return null;
	let parsedRule: FsRule | null = null;
	switch (rule.kind) {
		case 'exact':
			if (typeof rule.path !== 'string' || rule.path.length === 0) return null;
			parsedRule = { kind: 'exact', path: rule.path };
			break;
		case 'workspace':
			parsedRule = { kind: 'workspace' };
			break;
		case 'workspace-glob':
			if (typeof rule.glob !== 'string' || rule.glob.length === 0) return null;
			parsedRule = { kind: 'workspace-glob', glob: rule.glob };
			break;
		case 'prefix':
			if (typeof rule.path !== 'string' || rule.path.length === 0) return null;
			parsedRule = { kind: 'prefix', path: rule.path };
			break;
	}
	if (!parsedRule) return null;

	const out: FsScope = { kind: 'fs', rule: parsedRule };
	if (v.perms !== undefined) {
		if (!Array.isArray(v.perms)) return null;
		const perms: ('read' | 'write' | 'edit')[] = [];
		for (const p of v.perms) {
			if (p === 'read' || p === 'write' || p === 'edit') perms.push(p);
			else return null;
		}
		out.perms = perms;
	}
	return out;
}

function validateUrl(v: Record<string, unknown>): UrlScope | null {
	const rule = isObject(v.rule) ? (v.rule as Record<string, unknown>) : null;
	if (!rule) return null;
	let parsedRule: UrlRule | null = null;
	switch (rule.kind) {
		case 'exact':
			if (typeof rule.url !== 'string' || rule.url.length === 0) return null;
			parsedRule = { kind: 'exact', url: rule.url };
			break;
		case 'host':
			if (typeof rule.host !== 'string' || rule.host.length === 0) return null;
			parsedRule = { kind: 'host', host: rule.host };
			break;
		case 'host-suffix':
			if (typeof rule.suffix !== 'string' || rule.suffix.length === 0) return null;
			parsedRule = { kind: 'host-suffix', suffix: rule.suffix };
			break;
	}
	if (!parsedRule) return null;
	return { kind: 'url', rule: parsedRule };
}

function asStringList(v: unknown): string[] | null {
	if (!Array.isArray(v)) return null;
	const out: string[] = [];
	for (const s of v) {
		if (typeof s !== 'string' || s.length === 0) return null;
		out.push(s);
	}
	return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}
