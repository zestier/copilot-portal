<script lang="ts">
	import type { ToolCallRecord } from '$lib/types';
	import DiffView from './DiffView.svelte';
	import TerminalBlock from './tool/TerminalBlock.svelte';
	import ResultBlock from './tool/ResultBlock.svelte';
	import { synthesizeDiff } from '$lib/client/diff-synth';
	import { summarizeToolCall } from '$lib/client/tool-summary';
	import { decodeToolResult } from '$lib/client/tool-result';

	let { toolCall }: { toolCall: ToolCallRecord } = $props();

	// Default-closed; users opt in to seeing args + result by clicking.
	// We don't auto-expand while pending: the summary header already
	// surfaces the tool name, target, and progress message, which is
	// enough running feedback for the quick tool calls that make up the
	// bulk of a turn. (Subagents have their own auto-expand because they
	// run longer and have richer interior content.)
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

	const summary = $derived(summarizeToolCall(toolCall.tool, toolCall.argsJson));
	const decoded = $derived(decodeToolResult(toolCall.resultJson));
	const pending = $derived(toolCall.status === 'pending');
	// Edits/creates render as a unified diff synthesized from args. We only
	// show the diff once the call succeeded; while pending we'd be
	// rendering args that haven't been applied, and on error the result
	// text usually explains the failure.
	const synthDiff = $derived(toolCall.status === 'ok' ? synthesizeDiff(toolCall) : null);
</script>

<details class="tool" class:open class:is-pending={pending} bind:open>
	<summary>
		<span class="emoji">{statusEmoji(toolCall.status)}</span>
		<code>{toolCall.tool}</code>
		{#if summary}
			<span class="summary-text">{summary}</span>
		{:else}
			<span class="muted">— {toolCall.status}</span>
		{/if}
		{#if pending && toolCall.progressMessage}
			<span class="progress" title={toolCall.progressMessage}>· {toolCall.progressMessage}</span>
		{/if}
	</summary>
	<div class="content">
		<details class="args">
			<summary class="disclosure">Arguments</summary>
			<pre><code>{toolCall.argsJson}</code></pre>
		</details>

		{#if pending}
			{#if toolCall.partialOutput}
				<TerminalBlock text={toolCall.partialOutput} streaming />
			{:else if toolCall.progressMessage}
				<div class="muted progress-line">{toolCall.progressMessage}</div>
			{:else}
				<div class="muted">Running…</div>
			{/if}
		{:else if toolCall.resultJson}
			{#if synthDiff}
				<DiffView path={synthDiff.path} diff={synthDiff.diff} />
			{:else}
				{#each decoded.blocks as block, i (i)}
					<ResultBlock {block} />
				{/each}
			{/if}
			<details class="raw">
				<summary class="disclosure">Raw output</summary>
				<pre><code>{toolCall.resultJson}</code></pre>
			</details>
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
	.tool.is-pending {
		border-left: 3px solid var(--accent, #7c5cff);
		animation: tool-pulse 1.6s ease-in-out infinite;
	}
	@keyframes tool-pulse {
		0%,
		100% {
			border-left-color: var(--accent, #7c5cff);
		}
		50% {
			border-left-color: color-mix(in srgb, var(--accent, #7c5cff) 35%, transparent);
		}
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
	.progress {
		margin-left: 0.5rem;
		color: var(--text-muted);
		font-size: var(--fs-xs);
		font-style: italic;
		max-width: 24em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		display: inline-block;
		vertical-align: bottom;
	}
	.progress-line {
		font-style: italic;
		font-size: var(--fs-sm);
		margin: 0.4rem 0;
	}
	.content {
		margin-top: 0.4rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.disclosure {
		cursor: pointer;
		list-style: none;
		font-size: 0.7em;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
		user-select: none;
	}
	.disclosure::-webkit-details-marker {
		display: none;
	}
	.args[open] > .disclosure,
	.raw[open] > .disclosure {
		margin-bottom: 0.3rem;
	}
	pre {
		margin: 0;
		max-width: 100%;
		overflow-x: auto;
	}
</style>
