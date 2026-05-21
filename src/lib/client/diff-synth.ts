// Synthesize a unified-diff string from the arguments of file-mutation tool
// calls (create, edit, write_file, etc.) so the existing DiffView component
// can render the change. The Copilot SDK doesn't always emit a structured
// diff in the tool result; the args themselves contain enough information
// to reconstruct one.
//
// This is best-effort: callers should be prepared for `null` (e.g. when
// args don't match a known shape) and fall back to rendering the raw
// result text.

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

// Build a unified diff hunk for `oldLines` → `newLines`. We don't try to
// minimize the hunk (no LCS); we just emit the entire old block as deletions
// followed by the entire new block as additions. That keeps the
// implementation small and the rendered output matches what users expect
// from a "before/after" edit summary.
function buildHunk(oldLines: string[], newLines: string[]): string {
	const oldCount = oldLines.length;
	const newCount = newLines.length;
	const header = `@@ -1,${oldCount} +1,${newCount} @@`;
	const body: string[] = [header];
	for (const l of oldLines) body.push('-' + l);
	for (const l of newLines) body.push('+' + l);
	return body.join('\n');
}

function splitLines(s: string): string[] {
	if (s === '') return [];
	// Strip a single trailing newline so the diff doesn't show a blank
	// final line — matches `git diff` convention.
	const trimmed = s.endsWith('\n') ? s.slice(0, -1) : s;
	return trimmed.split('\n');
}

// Try to derive a diff from {old_str, new_str} edit-style args. Returns
// null if either string isn't present.
function fromEditArgs(path: string, args: ParsedArgs): SynthDiff | null {
	const oldStr = str(args.old_str) ?? str(args.old_string) ?? str(args.search);
	const newStr = str(args.new_str) ?? str(args.new_string) ?? str(args.replace);
	if (oldStr == null || newStr == null) return null;
	const diff = `--- a/${path}\n+++ b/${path}\n${buildHunk(splitLines(oldStr), splitLines(newStr))}`;
	return { path, diff };
}

// Try to derive a diff from {file_text} create-style args (full file body
// for a new file).
function fromCreateArgs(path: string, args: ParsedArgs): SynthDiff | null {
	const body = str(args.file_text) ?? str(args.content) ?? str(args.contents) ?? str(args.text);
	if (body == null) return null;
	const lines = splitLines(body);
	const diff = `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => '+' + l).join('\n')}`;
	return { path, diff };
}

const EDIT_TOOLS = new Set(['edit', 'str_replace_editor', 'replace', 'apply_patch']);
const CREATE_TOOLS = new Set(['create', 'create_file', 'write', 'write_file', 'new_file']);

export function synthesizeDiff(input: SynthDiffInput): SynthDiff | null {
	const args = parseArgs(input.argsJson);
	if (!args) return null;
	const path = str(args.path) ?? str(args.file) ?? str(args.filename) ?? str(args.file_path);
	if (!path) return null;
	const t = input.tool.toLowerCase();
	if (EDIT_TOOLS.has(t)) return fromEditArgs(path, args);
	if (CREATE_TOOLS.has(t)) return fromCreateArgs(path, args);
	// Be tolerant: some tools accept either shape. Try edit first, fall
	// back to create.
	return fromEditArgs(path, args) ?? fromCreateArgs(path, args);
}
