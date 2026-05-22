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
	switch (t) {
		case 'bash':
		case 'shell':
		case 'run': {
			const desc = str(args.description);
			if (desc) return desc;
			const cmd = str(args.command) ?? str(args.cmd);
			return cmd ? truncate(cmd, 60) : null;
		}
		case 'view':
		case 'read':
		case 'read_file':
		case 'cat': {
			const p = str(args.path) ?? str(args.file) ?? str(args.filename);
			const range = Array.isArray(args.view_range) ? args.view_range : null;
			if (p && range && range.length === 2) return `${p} [${range[0]}-${range[1]}]`;
			return p;
		}
		case 'edit':
		case 'create':
		case 'write':
		case 'write_file':
			return str(args.path) ?? str(args.file) ?? str(args.filename);
		case 'grep': {
			const pat = str(args.pattern);
			const glob = str(args.glob) ?? str(args.type);
			if (pat && glob) return `${pat}  (${glob})`;
			return pat;
		}
		case 'glob':
			return str(args.pattern);
		case 'write_bash': {
			const input = str(args.input);
			return input ? truncate(input, 40) : null;
		}
		case 'read_bash':
		case 'stop_bash':
			return str(args.shellId);
		case 'task':
			return str(args.description) ?? str(args.name);
		case 'read_agent':
		case 'stop_agent':
			return str(args.agent_id);
		case 'write_agent': {
			const id = str(args.agent_id);
			const input = str(args.input);
			if (id && input) return `${id} ← ${truncate(input, 40)}`;
			return id ?? (input ? truncate(input, 60) : null);
		}
		case 'list_agents':
			return args.include_completed === false ? 'active only' : 'all agents';
		case 'report_intent':
			return str(args.intent);
		case 'web_fetch':
		case 'fetch':
			return str(args.url);
		case 'skill':
			return str(args.skill);
		case 'sql':
		case 'session_store_sql':
			return str(args.description) ?? (str(args.query) ? truncate(str(args.query)!, 60) : null);
	}
	for (const v of Object.values(args)) {
		if (typeof v === 'string' && v.length > 0) return truncate(v, 80);
	}
	return null;
}
