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
	ShellOptionRules,
	ShellOptionSpec,
	ShellOptionValueRule,
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

	if (rule.preSubcommandOptions !== undefined) {
		const parsed = validateShellOptionRules(rule.preSubcommandOptions);
		if (!parsed) return null;
		out.preSubcommandOptions = parsed;
	}

	if (rule.options !== undefined) {
		const parsed = validateShellOptionRules(rule.options);
		if (!parsed) return null;
		out.options = parsed;
	}

	if (rule.flags !== undefined) {
		if (out.preSubcommandOptions || out.options) return null;
		const legacy = validateLegacyFlags(rule.flags);
		if (!legacy) return null;
		out.options = legacy;
		if (out.subcommands && out.subcommands.length > 0) {
			out.preSubcommandOptions = legacy;
		}
	}

	if (rule.positionals !== undefined) {
		const p = validatePositionals(rule.positionals);
		if (!p) return null;
		out.positionals = p;
	}

	if (rule.pipeline !== undefined) {
		if (rule.pipeline !== 'must' && rule.pipeline !== 'forbid') return null;
		out.pipeline = rule.pipeline;
	}

	return { kind: 'shell', rule: out };
}

function validateShellOptionRules(v: unknown): ShellOptionRules | null {
	if (!isObject(v)) return null;
	const raw = v as Record<string, unknown>;
	const out: ShellOptionRules = {};
	if (raw.allow !== undefined) {
		if (!Array.isArray(raw.allow)) return null;
		const allow: ShellOptionSpec[] = [];
		for (const spec of raw.allow) {
			const parsed = validateShellOptionSpec(spec);
			if (!parsed) return null;
			allow.push(parsed);
		}
		out.allow = allow;
	}
	if (raw.deny !== undefined) {
		const deny = asFlagNameList(raw.deny);
		if (deny === null) return null;
		out.deny = deny;
	}
	if (out.allow === undefined && out.deny === undefined) return null;
	return out;
}

function validateShellOptionSpec(v: unknown): ShellOptionSpec | null {
	if (!isObject(v)) return null;
	const raw = v as Record<string, unknown>;
	if (!isFlagName(raw.name)) return null;
	if (raw.kind === 'flag') return { name: raw.name, kind: 'flag' };
	if (raw.kind !== 'option') return null;
	const value = validateShellOptionValue(raw.value);
	if (!value) return null;
	return { name: raw.name, kind: 'option', value };
}

function validateShellOptionValue(v: unknown): ShellOptionValueRule | null {
	if (!isObject(v)) return null;
	const kind = (v as { kind?: unknown }).kind;
	if (kind === 'any' || kind === 'workspace-path') {
		return { kind } as ShellOptionValueRule;
	}
	return null;
}

function validateLegacyFlags(v: unknown): ShellOptionRules | null {
	if (!isObject(v)) return null;
	const raw = v as Record<string, unknown>;
	const out: ShellOptionRules = {};
	if (raw.allow !== undefined) {
		const list = asFlagNameList(raw.allow);
		if (list === null) return null;
		out.allow = list.map((name) => ({ name, kind: 'flag' }));
	}
	if (raw.deny !== undefined) {
		const list = asFlagNameList(raw.deny);
		if (list === null) return null;
		out.deny = list;
	}
	if (out.allow === undefined && out.deny === undefined) return null;
	return out;
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

function asFlagNameList(v: unknown): string[] | null {
	const out = asStringList(v);
	if (out === null) return null;
	for (const s of out) {
		if (!isFlagName(s)) return null;
	}
	return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isFlagName(v: unknown): v is string {
	return typeof v === 'string' && v.length > 0 && v.startsWith('-');
}
