// Conservative shell-command parser used by the permission layer.
//
// We tokenize with `shell-quote` and then refuse to deal with anything we
// can't model safely: command substitution, redirection, subshells,
// unresolved variables, unexpanded globs, env-assignment prefixes,
// tilde expansion, and absolute/relative path invocations. When in doubt
// we return `{ kind: 'unsafe', reason }` and the caller falls back to
// prompting the user — we never auto-approve a string we don't fully
// understand.
//
// Two narrow exceptions are recognised as no-op redirections and
// elided before classification:
//
//   1. Pure file-descriptor duplication / close — `N>&M` or `N>&-`
//      (N optional, defaulting to fd 1; N and M single digits). Never
//      touches the filesystem.
//   2. Redirections targeting the literal path `/dev/null` — `N>`,
//      `N>>`, `&>`, or `<` (with optional whitespace before the path).
//      Writes are discarded; reads yield EOF. No FS effect.
//
// Both must be bounded by whitespace (or string start/end) on each
// side. We elide by regex-replacing each match with a sentinel string
// that:
//
//   1. Contains no shell-meaningful characters (alphanumerics + `_`
//      only), so the substitution cannot perturb shell-quote's view of
//      where strings start or end.
//   2. Sits in a whitespace gap, so it can never split a real shell
//      token. Inside a quoted string the sentinel just changes the
//      string contents from "...2>&1..." to "...SENTINEL..."; the
//      altered argv element is data either way.
//
// After parsing, we drop any argv element exactly equal to the
// sentinel. Substrings of larger string tokens (the in-quotes case)
// are left intact — they're data, and rule matching treats them
// consistently. Anything more exotic (file targets other than
// /dev/null, multi-digit fds, `<&`, `&>` to a real file, etc.) still
// falls through to the blanket "redirection" refusal below.
//
// Output for safe commands is a list of segments split on the four
// sequencing operators we DO understand: `&&`, `||`, `;`, `|`. Each
// segment is a plain argv (string[]); callers can then check whether
// every segment is safe according to a safe-list.

import { parse as shellQuoteParse } from 'shell-quote';

export type SequencingOp = '&&' | '||' | ';' | '|';

export interface ParsedSegment {
	argv: string[];
	/** Operator that separates this segment from the next. `null` on the
	 * final segment. */
	followingOp: SequencingOp | null;
}

export type ParseResult =
	| { kind: 'parsed'; segments: ParsedSegment[] }
	| { kind: 'unsafe'; reason: string };

const ALLOWED_OPS: ReadonlySet<string> = new Set(['&&', '||', ';', '|']);

// shell-quote represents an unresolved variable reference as `{op: '@',
// pattern: name}` when the env callback returns an object instead of a
// string. We use this to refuse any command that depends on a variable
// we can't evaluate.
const VAR_SENTINEL = (name: string) => ({ op: '@' as const, pattern: name });

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function parseShellCommand(command: string): ParseResult {
	const trimmed = elideSafeRedirections(command).trim();
	if (trimmed === '') return { kind: 'unsafe', reason: 'empty command' };

	let tokens: unknown[];
	try {
		tokens = shellQuoteParse(trimmed, VAR_SENTINEL as never) as unknown[];
	} catch (e) {
		return { kind: 'unsafe', reason: `parse error: ${(e as Error).message}` };
	}

	const segments: ParsedSegment[] = [];
	let current: string[] = [];

	for (const tok of tokens) {
		if (typeof tok === 'string') {
			if (tok === SAFE_REDIR_SENTINEL) continue;
			const verdict = classifyStringToken(tok, current.length === 0);
			if (verdict !== 'ok') return { kind: 'unsafe', reason: verdict };
			current.push(tok);
			continue;
		}

		if (tok && typeof tok === 'object' && 'op' in tok) {
			const op = (tok as { op: string }).op;
			if (ALLOWED_OPS.has(op)) {
				if (current.length === 0) {
					return { kind: 'unsafe', reason: `empty segment before '${op}'` };
				}
				segments.push({ argv: current, followingOp: op as SequencingOp });
				current = [];
				continue;
			}
			return { kind: 'unsafe', reason: unsafeOpReason(op) };
		}

		return { kind: 'unsafe', reason: 'unknown token shape' };
	}

	if (current.length === 0) {
		return { kind: 'unsafe', reason: 'trailing operator with no command' };
	}
	segments.push({ argv: current, followingOp: null });

	return { kind: 'parsed', segments };
}

function classifyStringToken(tok: string, isFirstOfSegment: boolean): 'ok' | string {
	if (tok.length === 0) return 'empty token';
	// shell-quote leaves backticks in literal tokens (it doesn't parse
	// backtick command substitution). Reject any token containing one.
	if (tok.includes('`')) return 'backtick command substitution';
	// A bare `$` token shows up as the prefix of `$(...)` in shell-quote's
	// output (the subsequent `(`/`)` ops would also trip us, but catch it
	// early for a clearer error).
	if (tok === '$') return 'command substitution';
	if (tok.startsWith('~')) return 'tilde expansion';
	if (isFirstOfSegment) {
		if (ENV_ASSIGN_RE.test(tok)) return 'env-assignment prefix';
		if (tok.includes('/')) return 'path-qualified command';
		if (tok.startsWith('.')) return 'relative-path command';
	}
	return 'ok';
}

function unsafeOpReason(op: string): string {
	switch (op) {
		case '@':
			return 'variable expansion';
		case 'glob':
			return 'unexpanded glob';
		case 'comment':
			return 'shell comment';
		case '(':
		case ')':
			return 'subshell or command substitution';
		case '>':
		case '>>':
		case '<':
		case '<<':
		case '>&':
		case '<&':
		case '&>':
			return 'redirection';
		case '&':
			return 'background execution';
		default:
			return `unsafe operator '${op}'`;
	}
}

// Quote-agnostic elision of no-op redirections, applied before
// tokenization. Two categories are covered:
//
//   1. Pure fd duplication / close: `N>&M` or `N>&-` (N optional,
//      defaulting to fd 1; N and M single digits). No FS effect.
//   2. /dev/null targets: `N>`, `N>>`, `&>`, or `<` aimed at the
//      literal path `/dev/null`. Writes are discarded; reads yield
//      EOF. No FS effect.
//
// In both cases, matches must be bounded by whitespace (or string
// start/end) so the substitution lands in a token gap or inside a
// quoted string (where the result is data either way — see the file
// header). For /dev/null we allow optional whitespace between the
// redirect operator and the path so that `> /dev/null` is matched the
// same as `>/dev/null`; both forms are equivalent in bash.
//
// The sentinel matches `[A-Za-z_][A-Za-z0-9_]*` — no shell
// metacharacters — so the substitution cannot perturb shell-quote's
// view of where strings begin or end. If a caller really passes a
// command containing this exact identifier, parsing treats it as the
// elided marker; acceptable for an obviously-internal token.
const SAFE_REDIR_SENTINEL = '__COPILOT_PORTAL_SAFE_REDIR__';
const SAFE_REDIR_RE = /(?<=\s|^)(?:\d?>&(?:\d|-)|(?:\d?>>?|&>|\d?<)\s*\/dev\/null)(?=\s|$)/g;

function elideSafeRedirections(input: string): string {
	return input.replace(SAFE_REDIR_RE, SAFE_REDIR_SENTINEL);
}
