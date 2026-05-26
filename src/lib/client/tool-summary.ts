// Header-line summary text for tool calls (e.g. "bash · echo hi" or
// "view · src/foo.ts [1-30]"). Pure: a function of the tool name and the
// JSON-encoded arguments. Kept out of the renderer so it can be unit
// tested without spinning up Svelte.

import { parseApplyPatch } from './apply-patch';

function truncate(s: string, n = 80): string {
	const oneLine = s.replace(/\s+/g, ' ').trim();
	return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine;
}

function parseArgs(json: string): Record<string, unknown> | null {
	try {
		const v = JSON.parse(json);
		return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function str(v: unknown): string | null {
	return typeof v === 'string' && v.length > 0 ? v : null;
}

type SummaryHandler = (args: Record<string, unknown>) => string | null;

const summaryHandlers: Record<string, SummaryHandler> = {
	bash: commandSummary,
	shell: commandSummary,
	run: commandSummary,
	view: readPathSummary,
	read: readPathSummary,
	read_file: readPathSummary,
	cat: readPathSummary,
	edit: pathSummary,
	create: pathSummary,
	write: pathSummary,
	write_file: pathSummary,
	grep: grepSummary,
	glob: patternSummary,
	write_bash: writeBashSummary,
	read_bash: shellIdSummary,
	stop_bash: shellIdSummary,
	task: taskSummary,
	read_agent: agentIdSummary,
	stop_agent: agentIdSummary,
	write_agent: writeAgentSummary,
	list_agents: listAgentsSummary,
	report_intent: intentSummary,
	web_fetch: urlSummary,
	fetch: urlSummary,
	git_diff: gitDiffSummary,
	git_log: gitLogSummary,
	git_show_commit: gitShowCommitSummary,
	git_commit: gitCommitSummary,
	skill: skillSummary,
	sql: sqlSummary,
	session_store_sql: sqlSummary
};

export function summarizeToolCall(tool: string, argsJson: string): string | null {
	const t = tool.toLowerCase();
	if (t === 'apply_patch') {
		const changes = parseApplyPatch(argsJson);
		if (changes?.length) {
			return changes.length === 1
				? changes[0].path
				: `${changes[0].path} +${changes.length - 1} more`;
		}
	}

	const args = parseArgs(argsJson);
	if (!args) return null;
	const handler = summaryHandlers[t];
	if (handler) return handler(args);
	for (const v of Object.values(args)) {
		if (typeof v === 'string' && v.length > 0) return truncate(v, 80);
	}
	return null;
}

function commandSummary(args: Record<string, unknown>): string | null {
	const desc = str(args.description);
	if (desc) return desc;
	const cmd = str(args.command) ?? str(args.cmd);
	return cmd ? truncate(cmd, 60) : null;
}

function pathSummary(args: Record<string, unknown>): string | null {
	return str(args.path) ?? str(args.file) ?? str(args.filename);
}

function readPathSummary(args: Record<string, unknown>): string | null {
	const p = pathSummary(args);
	const range = Array.isArray(args.view_range) ? args.view_range : null;
	if (p && range && range.length === 2) return `${p} [${range[0]}-${range[1]}]`;
	return p;
}

function grepSummary(args: Record<string, unknown>): string | null {
	const pat = str(args.pattern);
	const glob = str(args.glob) ?? str(args.type);
	if (pat && glob) return `${pat}  (${glob})`;
	return pat;
}

function patternSummary(args: Record<string, unknown>): string | null {
	return str(args.pattern);
}

function writeBashSummary(args: Record<string, unknown>): string | null {
	const input = str(args.input);
	return input ? truncate(input, 40) : null;
}

function shellIdSummary(args: Record<string, unknown>): string | null {
	return str(args.shellId);
}

function taskSummary(args: Record<string, unknown>): string | null {
	return str(args.description) ?? str(args.name);
}

function agentIdSummary(args: Record<string, unknown>): string | null {
	return str(args.agent_id);
}

function writeAgentSummary(args: Record<string, unknown>): string | null {
	const id = str(args.agent_id);
	const input = str(args.input);
	if (id && input) return `${id} ← ${truncate(input, 40)}`;
	return id ?? (input ? truncate(input, 60) : null);
}

function listAgentsSummary(args: Record<string, unknown>): string {
	return args.include_completed === false ? 'active only' : 'all agents';
}

function intentSummary(args: Record<string, unknown>): string | null {
	return str(args.intent);
}

function urlSummary(args: Record<string, unknown>): string | null {
	return str(args.url);
}

function gitDiffSummary(args: Record<string, unknown>): string {
	const output = str(args.output) ?? 'patch';
	const target = str(args.target) ?? 'worktree-vs-head';
	const path = str(args.path);
	return [output, target, path].filter(Boolean).join(' · ');
}

function gitLogSummary(args: Record<string, unknown>): string | null {
	const ref = str(args.ref);
	const path = str(args.path);
	if (ref && path) return `${ref} · ${path}`;
	return path ?? ref ?? null;
}

function gitShowCommitSummary(args: Record<string, unknown>): string | null {
	const sha = str(args.sha);
	return args.includePatch === true && sha ? `${sha} · patch` : sha;
}

function gitCommitSummary(args: Record<string, unknown>): string | null {
	const subject = str(args.subject);
	const paths = args.paths;
	const trailers = Array.isArray(args.trailers) ? args.trailers.length : 0;
	const hasBody = str(args.body) !== null;
	const target =
		paths === 'all'
			? 'all changes'
			: Array.isArray(paths)
				? paths.length === 1
					? String(paths[0])
					: `${String(paths[0])} +${paths.length - 1} more`
				: null;
	const extras = [hasBody ? 'body' : null, trailers ? `${trailers} trailers` : null].filter(
		Boolean
	);
	const main = [subject ? truncate(subject, 50) : null, target].filter(Boolean).join(' · ');
	return [main || null, ...extras].filter(Boolean).join(' · ') || null;
}

function skillSummary(args: Record<string, unknown>): string | null {
	return str(args.skill);
}

function sqlSummary(args: Record<string, unknown>): string | null {
	const query = str(args.query);
	return str(args.description) ?? (query ? truncate(query, 60) : null);
}
