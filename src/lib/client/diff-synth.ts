import { createTwoFilesPatch } from 'diff';
import { parseApplyPatch } from './apply-patch';

// Synthesize a unified-diff string from the arguments of file-mutation tool
// calls (create, edit, write_file, etc.) so the existing DiffView component
// can render the change. The Copilot SDK doesn't always emit a structured
// diff in the tool result; the args themselves contain enough information
// to reconstruct one.
//
// We delegate the actual diff math to `jsdiff` so the output has proper
// LCS-based context lines instead of marking every line in the edit block
// as changed. The library prepends an `Index:` / `===` header that
// `parseUnifiedDiff` doesn't understand, so we strip it.

export interface SynthDiffInput {
	tool: string;
	argsJson: string;
}

export interface SynthDiff {
	path: string;
	diff: string;
}

interface ParsedArgs {
	[key: string]: unknown;
}

function parseArgs(json: string): ParsedArgs | null {
	try {
		const v = JSON.parse(json);
		return v && typeof v === 'object' && !Array.isArray(v) ? (v as ParsedArgs) : null;
	} catch {
		return null;
	}
}

function str(v: unknown): string | null {
	return typeof v === 'string' ? v : null;
}

// jsdiff returns a "Index:" / "===" preamble and tab-padded ---/+++ headers
// (GNU diff quirk). Strip the preamble and trim the header whitespace so
// the output matches what `parseUnifiedDiff` expects.
function cleanPatch(patch: string): string {
	const lines = patch.split('\n');
	let i = 0;
	if (lines[i]?.startsWith('Index:')) i += 1;
	if (lines[i]?.startsWith('===')) i += 1;
	const rest = lines.slice(i);
	if (rest[0]?.startsWith('--- ')) rest[0] = rest[0].replace(/\s+$/, '');
	if (rest[1]?.startsWith('+++ ')) rest[1] = rest[1].replace(/\s+$/, '');
	return rest.join('\n');
}

function fromEditArgs(path: string, args: ParsedArgs): SynthDiff | null {
	const oldStr = str(args.old_str) ?? str(args.old_string) ?? str(args.search);
	const newStr = str(args.new_str) ?? str(args.new_string) ?? str(args.replace);
	if (oldStr == null || newStr == null) return null;
	const patch = createTwoFilesPatch(`a/${path}`, `b/${path}`, oldStr, newStr, '', '', {
		context: 3
	});
	return { path, diff: cleanPatch(patch) };
}

function fromCreateArgs(path: string, args: ParsedArgs): SynthDiff | null {
	const body = str(args.file_text) ?? str(args.content) ?? str(args.contents) ?? str(args.text);
	if (body == null) return null;
	const patch = createTwoFilesPatch('/dev/null', `b/${path}`, '', body, '', '', { context: 3 });
	return { path, diff: cleanPatch(patch) };
}

const EDIT_TOOLS = new Set(['edit', 'str_replace_editor', 'replace', 'apply_patch']);
const CREATE_TOOLS = new Set(['create', 'create_file', 'write', 'write_file', 'new_file']);

export function synthesizeDiffs(input: SynthDiffInput): SynthDiff[] {
	const t = input.tool.toLowerCase();
	if (t === 'apply_patch') return parseApplyPatch(input.argsJson) ?? [];

	const args = parseArgs(input.argsJson);
	if (!args) return [];
	const path = str(args.path) ?? str(args.file) ?? str(args.filename) ?? str(args.file_path);
	if (!path) return [];
	if (EDIT_TOOLS.has(t)) {
		const diff = fromEditArgs(path, args);
		return diff ? [diff] : [];
	}
	if (CREATE_TOOLS.has(t)) {
		const diff = fromCreateArgs(path, args);
		return diff ? [diff] : [];
	}
	// Be tolerant: some tools accept either shape. Try edit first, fall
	// back to create.
	return [fromEditArgs(path, args) ?? fromCreateArgs(path, args)].filter(
		(v): v is SynthDiff => v != null
	);
}

export function synthesizeDiff(input: SynthDiffInput): SynthDiff | null {
	return synthesizeDiffs(input)[0] ?? null;
}
