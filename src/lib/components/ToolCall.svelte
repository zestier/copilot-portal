<script lang="ts">
	import type { ToolCallRecord } from '$lib/types';
	let { toolCall }: { toolCall: ToolCallRecord } = $props();
	let open = $state(false);
	function statusEmoji(s: ToolCallRecord['status']) {
		switch (s) {
			case 'ok':
				return '✓';
			case 'error':
				return '✗';
			case 'denied':
				return '⛔';
			default:
				return '⏳';
		}
	}

	function truncate(s: string, n = 80): string {
		const oneLine = s.replace(/\s+/g, ' ').trim();
		return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine;
	}

	function parseArgs(json: string): Record<string, unknown> | null {
		try {
			const v = JSON.parse(json);
			return v && typeof v === 'object' && !Array.isArray(v)
				? (v as Record<string, unknown>)
				: null;
		} catch {
			return null;
		}
	}

	function str(v: unknown): string | null {
		return typeof v === 'string' && v.length > 0 ? v : null;
	}

	function summarize(tool: string, argsJson: string): string | null {
		const args = parseArgs(argsJson);
		if (!args) return null;
		const t = tool.toLowerCase();
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

	let summary = $derived(summarize(toolCall.tool, toolCall.argsJson));
</script>

<details class="tool" class:open bind:open>
	<summary>
		<span class="emoji">{statusEmoji(toolCall.status)}</span>
		<code>{toolCall.tool}</code>
		{#if summary}
			<span class="summary-text">{summary}</span>
		{:else}
			<span class="muted">— {toolCall.status}</span>
		{/if}
	</summary>
	<div class="content">
		<div class="label">Arguments</div>
		<pre><code>{toolCall.argsJson}</code></pre>
		{#if toolCall.resultJson}
			<div class="label">Result</div>
			<pre><code>{toolCall.resultJson}</code></pre>
		{/if}
	</div>
</details>

<style>
	.tool {
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		padding: var(--space-2) var(--space-3);
		font-size: var(--fs-md);
	}
	summary {
		cursor: pointer;
		list-style: none;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	.emoji {
		margin-right: 0.4rem;
	}
	.summary-text {
		margin-left: 0.5rem;
		color: var(--text-muted);
		font-family: var(--mono);
		font-size: var(--fs-sm);
	}
	.content {
		margin-top: 0.4rem;
	}
	.label {
		font-size: 0.7em;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
		margin: 0.4rem 0 0.2rem;
	}
</style>
