// Predicate for ShellScope grants — `shell` permission requests.
//
// Callers are expected to have already run the command through
// `shell-parser` and refused to consider structured grants for commands
// the parser couldn't fully understand. This module focuses on the
// structural question: does this rule cover this argv?

import type { ShellRule, PositionalsRule } from '../../../permissions/scope-types';
import type { ParsedSegment } from '../shell-parser';
import { isPathInWorkspace } from '../workspace';

export interface ShellMatchContext {
	/** Conversation's workspace root. `workspace-paths` fails closed when null. */
	workspaceRoot: string | null;
}

/**
 * Returns true iff EVERY segment of the parsed command satisfies this
 * rule. Pipelines and chains (`a && b`, `a | b`) must satisfy the same
 * rule on every segment — callers wanting different rules per segment
 * should issue separate grants and let the matcher OR them.
 */
export function shellRuleMatches(
	rule: ShellRule,
	segments: ParsedSegment[],
	ctx: ShellMatchContext
): boolean {
	if (segments.length === 0) return false;
	for (const seg of segments) {
		if (!shellRuleMatchesSegment(rule, seg, ctx)) return false;
	}
	return true;
}

/**
 * Returns true iff this single parsed segment satisfies the rule.
 * The matcher uses this directly to evaluate each segment of a chained
 * command independently — one rule may cover `cd ./src`, a different
 * rule may cover the `git diff` that follows the `&&`, and the request
 * is allowed as long as every segment has some allow rule covering it
 * (and none have a deny). Single-rule "all segments" callers should
 * keep using `shellRuleMatches`.
 */
export function shellRuleMatchesSegment(
	rule: ShellRule,
	seg: ParsedSegment,
	ctx: ShellMatchContext
): boolean {
	const argv = seg.argv;
	if (argv.length === 0) return false;
	if (argv[0] !== rule.argv0) return false;

	if (rule.subcommands && rule.subcommands.length > 0) {
		const sub = argv[1];
		if (typeof sub !== 'string' || !rule.subcommands.includes(sub)) return false;
	}

	const startIndex = rule.subcommands ? 2 : 1;
	const flags: string[] = [];
	const positionals: string[] = [];
	for (let i = startIndex; i < argv.length; i++) {
		const tok = argv[i];
		if (typeof tok !== 'string') return false;
		if (tok.startsWith('-') && tok !== '-' && tok !== '--') flags.push(tok);
		else positionals.push(tok);
	}

	if (rule.flags?.deny) {
		for (const tok of flags) {
			for (const denied of rule.flags.deny) {
				if (tok === denied || tok.startsWith(denied + '=')) return false;
			}
		}
	}
	if (rule.flags?.allow) {
		for (const tok of flags) {
			let ok = false;
			for (const allowed of rule.flags.allow) {
				if (tok === allowed || tok.startsWith(allowed + '=')) {
					ok = true;
					break;
				}
			}
			if (!ok) return false;
		}
	}

	if (!positionalsMatch(rule.positionals, positionals, ctx)) return false;

	return true;
}

function positionalsMatch(
	rule: PositionalsRule | undefined,
	positionals: string[],
	ctx: ShellMatchContext
): boolean {
	if (!rule) return true;
	switch (rule.kind) {
		case 'any':
			return true;
		case 'none':
			return positionals.length === 0;
		case 'workspace-paths': {
			if (!ctx.workspaceRoot) return false;
			for (const p of positionals) {
				if (!isPathInWorkspace(p, ctx.workspaceRoot)) return false;
			}
			return true;
		}
	}
}
