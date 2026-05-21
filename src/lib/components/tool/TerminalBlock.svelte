<script lang="ts">
	// Terminal-style output pane. Used both for the live `partialOutput`
	// stream while a tool is running and for the final `terminal` content
	// block returned by tools like bash.
	let {
		text,
		cwd,
		exitCode,
		streaming = false
	}: {
		text: string;
		cwd?: string;
		exitCode?: number;
		streaming?: boolean;
	} = $props();

	const hasHeader = $derived(cwd != null || exitCode != null);
</script>

<div class="terminal-block" class:streaming>
	{#if hasHeader}
		<div class="header">
			{#if cwd}<code class="cwd" title={cwd}>{cwd}</code>{/if}
			{#if exitCode != null}
				<span class="exit-code" data-ok={exitCode === 0}>exit {exitCode}</span>
			{/if}
		</div>
	{/if}
	<pre class="body"><code>{text}</code>{#if streaming}<span class="cursor" aria-hidden="true"
				>▍</span
			>{/if}</pre>
</div>

<style>
	.terminal-block {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		overflow: hidden;
		background: var(--bg, #0b0b0e);
	}
	.header {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.25rem 0.55rem;
		background: var(--surface);
		border-bottom: 1px solid var(--border);
		font-size: var(--fs-xs);
		font-family: var(--mono);
		color: var(--text-muted);
	}
	.cwd {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.exit-code {
		padding: 0.05rem 0.4rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--danger, #e5484d) 22%, transparent);
		color: var(--danger, #e5484d);
		font-family: var(--mono);
	}
	.exit-code[data-ok='true'] {
		background: color-mix(in srgb, var(--success, #30a46c) 22%, transparent);
		color: var(--success, #30a46c);
	}
	.body {
		font-family: var(--mono);
		font-size: 0.85em;
		line-height: 1.45;
		padding: 0.5rem 0.6rem;
		background: var(--bg, #0b0b0e);
		color: var(--text);
		overflow-x: auto;
		overflow-y: auto;
		white-space: pre-wrap;
		word-break: break-all;
		max-height: 28em;
		margin: 0;
	}
	.cursor {
		display: inline-block;
		color: var(--accent, #7c5cff);
		animation: cursor-blink 1s steps(2, start) infinite;
	}
	@keyframes cursor-blink {
		to {
			visibility: hidden;
		}
	}
</style>
