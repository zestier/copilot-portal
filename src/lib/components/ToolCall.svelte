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
</script>

<details class="tool" class:open bind:open>
	<summary>
		<span class="emoji">{statusEmoji(toolCall.status)}</span>
		<code>{toolCall.tool}</code>
		<span class="muted">— {toolCall.status}</span>
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
		border-radius: 6px;
		padding: 0.4rem 0.6rem;
		font-size: 0.9em;
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
