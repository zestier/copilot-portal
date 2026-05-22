import { describe, it, expect } from 'vitest';
import { synthesizeDiff, synthesizeDiffs } from '../src/lib/client/diff-synth';
import { parseUnifiedDiff, diffStats } from '../src/lib/client/diff-parser';

describe('synthesizeDiff', () => {
	it('synthesizes a diff for edit-style {old_str, new_str} args', () => {
		const r = synthesizeDiff({
			tool: 'edit',
			argsJson: JSON.stringify({
				path: 'src/foo.ts',
				old_str: 'const x = 1;\nconst y = 2;',
				new_str: 'const x = 10;\nconst y = 20;'
			})
		});
		expect(r).not.toBeNull();
		expect(r!.path).toBe('src/foo.ts');
		const stats = diffStats(parseUnifiedDiff(r!.diff));
		expect(stats.added).toBe(2);
		expect(stats.removed).toBe(2);
	});

	it('synthesizes a diff for create-style {file_text} args', () => {
		const r = synthesizeDiff({
			tool: 'create',
			argsJson: JSON.stringify({
				path: 'new.txt',
				file_text: 'hello\nworld\n'
			})
		});
		expect(r).not.toBeNull();
		const parsed = parseUnifiedDiff(r!.diff);
		const stats = diffStats(parsed);
		expect(stats.added).toBe(2);
		expect(stats.removed).toBe(0);
	});

	it('returns null when no path is present', () => {
		const r = synthesizeDiff({
			tool: 'edit',
			argsJson: JSON.stringify({ old_str: 'a', new_str: 'b' })
		});
		expect(r).toBeNull();
	});

	it('returns null for non-mutation tools when args do not match a known shape', () => {
		const r = synthesizeDiff({
			tool: 'bash',
			argsJson: JSON.stringify({ command: 'ls -la' })
		});
		expect(r).toBeNull();
	});

	it('handles aliases (write_file with content)', () => {
		const r = synthesizeDiff({
			tool: 'write_file',
			argsJson: JSON.stringify({ filename: 'a.md', content: 'hi' })
		});
		expect(r).not.toBeNull();
		expect(r!.path).toBe('a.md');
	});

	it('preserves unchanged lines as context (LCS-based, not whole-block replacement)', () => {
		const r = synthesizeDiff({
			tool: 'edit',
			argsJson: JSON.stringify({
				path: 'f.ts',
				old_str: 'line1\nline2\nline3\nline4',
				new_str: 'line1\nLINE2\nline3\nline4'
			})
		});
		expect(r).not.toBeNull();
		const parsed = parseUnifiedDiff(r!.diff);
		const stats = diffStats(parsed);
		// Only line2 changed; the other three lines must be context, not
		// re-emitted as add/del.
		expect(stats.added).toBe(1);
		expect(stats.removed).toBe(1);
		expect(parsed.filter((l) => l.kind === 'context').length).toBe(3);
	});

	it('returns null on malformed JSON', () => {
		expect(synthesizeDiff({ tool: 'edit', argsJson: 'not json' })).toBeNull();
	});

	it('synthesizes diffs for raw apply_patch input', () => {
		const r = synthesizeDiffs({
			tool: 'apply_patch',
			argsJson: [
				'*** Begin Patch',
				'*** Update File: src/foo.ts',
				'@@',
				'-const value = 1;',
				'+const value = 2;',
				'*** Add File: src/bar.ts',
				'+export const bar = true;',
				'*** End Patch'
			].join('\n')
		});
		expect(r).toHaveLength(2);
		expect(r[0]?.path).toBe('src/foo.ts');
		expect(diffStats(parseUnifiedDiff(r[0]!.diff))).toEqual({ added: 1, removed: 1 });
		expect(r[1]?.path).toBe('src/bar.ts');
		expect(diffStats(parseUnifiedDiff(r[1]!.diff))).toEqual({ added: 1, removed: 0 });
	});

	it('shows renames from apply_patch updates', () => {
		const r = synthesizeDiff({
			tool: 'apply_patch',
			argsJson: [
				'*** Begin Patch',
				'*** Update File: src/old.ts',
				'*** Move to: src/new.ts',
				'@@',
				' export const moved = true;',
				'*** End Patch'
			].join('\n')
		});
		expect(r).not.toBeNull();
		expect(r!.path).toBe('src/old.ts -> src/new.ts');
		expect(r!.diff).toContain('rename from src/old.ts');
		expect(r!.diff).toContain('rename to src/new.ts');
	});
});
