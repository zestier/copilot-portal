import { describe, it, expect } from 'vitest';
import { summarizeToolCall } from '../src/lib/client/tool-summary';
import { decodeToolResult, shouldRenderToolResultAsMarkdown } from '../src/lib/client/tool-result';

describe('summarizeToolCall', () => {
	it('uses description over command for bash', () => {
		expect(
			summarizeToolCall('bash', JSON.stringify({ command: 'echo hi', description: 'Greet' }))
		).toBe('Greet');
	});

	it('falls back to command when no description', () => {
		expect(summarizeToolCall('bash', JSON.stringify({ command: 'ls -la' }))).toBe('ls -la');
	});

	it('shows path with view_range for view', () => {
		expect(
			summarizeToolCall('view', JSON.stringify({ path: 'src/foo.ts', view_range: [1, 30] }))
		).toBe('src/foo.ts [1-30]');
	});

	it('shows pattern + glob for grep', () => {
		expect(summarizeToolCall('grep', JSON.stringify({ pattern: 'foo', glob: '*.ts' }))).toBe(
			'foo  (*.ts)'
		);
	});

	it('returns null on malformed args', () => {
		expect(summarizeToolCall('bash', 'not json')).toBeNull();
	});

	it('summarizes raw apply_patch input by touched files', () => {
		expect(
			summarizeToolCall(
				'apply_patch',
				[
					'*** Begin Patch',
					'*** Update File: src/foo.ts',
					'@@',
					'-a',
					'+b',
					'*** Add File: src/bar.ts',
					'+hello',
					'*** End Patch'
				].join('\n')
			)
		).toBe('src/foo.ts +1 more');
	});

	it('falls back to first string arg for unknown tools', () => {
		expect(summarizeToolCall('unknown_tool', JSON.stringify({ x: 'hello' }))).toBe('hello');
	});
});

describe('decodeToolResult', () => {
	it('returns empty for null', () => {
		expect(decodeToolResult(null)).toEqual({ blocks: [], fallbackText: null });
	});

	it('decodes a terminal content block with exitCode and cwd', () => {
		const r = decodeToolResult(
			JSON.stringify({
				content: 'hi',
				contents: [{ type: 'terminal', text: 'hi\n', exitCode: 0, cwd: '/tmp' }]
			})
		);
		expect(r.blocks).toHaveLength(1);
		const b = r.blocks[0];
		expect(b.kind).toBe('terminal');
		if (b.kind === 'terminal') {
			expect(b.text).toBe('hi\n');
			expect(b.exitCode).toBe(0);
			expect(b.cwd).toBe('/tmp');
		}
	});

	it('prefers detailedContent over content as fallback text', () => {
		const r = decodeToolResult(
			JSON.stringify({ content: 'short', detailedContent: 'full output' })
		);
		expect(r.blocks).toEqual([{ kind: 'text', text: 'full output' }]);
		expect(r.fallbackText).toBe('full output');
	});

	it('treats a bare string as a text block', () => {
		const r = decodeToolResult(JSON.stringify('plain output'));
		expect(r.blocks).toEqual([{ kind: 'text', text: 'plain output' }]);
	});

	it('falls back to raw text on malformed JSON', () => {
		const r = decodeToolResult('not valid json');
		expect(r.blocks).toEqual([{ kind: 'text', text: 'not valid json' }]);
	});

	it('decodes resource_link with optional description', () => {
		const r = decodeToolResult(
			JSON.stringify({
				contents: [{ type: 'resource_link', name: 'docs', uri: 'https://e.com', description: 'd' }]
			})
		);
		expect(r.blocks[0]).toMatchObject({
			kind: 'resource_link',
			name: 'docs',
			uri: 'https://e.com',
			description: 'd'
		});
	});

	it('skips malformed content blocks', () => {
		const r = decodeToolResult(
			JSON.stringify({
				contents: [
					{ type: 'text', text: 'ok' },
					{ type: 'image', data: 'x' }, // missing mimeType
					{ type: 'unknown' }
				],
				content: 'fallback'
			})
		);
		expect(r.blocks).toEqual([{ kind: 'text', text: 'ok' }]);
		expect(r.fallbackText).toBe('fallback');
	});
});

describe('shouldRenderToolResultAsMarkdown', () => {
	it('uses markdown for human-facing prose tools', () => {
		for (const tool of [
			'ask_user',
			'exit_plan_mode',
			'read_agent',
			'report_intent',
			'request_mode_switch',
			'task_complete'
		]) {
			expect(shouldRenderToolResultAsMarkdown(tool)).toBe(true);
			expect(shouldRenderToolResultAsMarkdown(tool.toUpperCase())).toBe(true);
		}
	});

	it('keeps data and command output in the existing plain renderer', () => {
		for (const tool of ['bash', 'view', 'rg', 'sql', 'session_store_sql']) {
			expect(shouldRenderToolResultAsMarkdown(tool)).toBe(false);
		}
	});
});
