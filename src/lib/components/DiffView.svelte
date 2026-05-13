<script lang="ts">
	let { path, diff }: { path: string; diff: string } = $props();
	const lines = $derived(diff.split('\n'));
	function classFor(l: string) {
		if (l.startsWith('+') && !l.startsWith('+++')) return 'add';
		if (l.startsWith('-') && !l.startsWith('---')) return 'del';
		if (l.startsWith('@@')) return 'hunk';
		return '';
	}
</script>

<div class="diff">
	<div class="path">
		<code>{path}</code>
	</div>
	<pre class="lines">{#each lines as l, i (i)}<span class={'line ' + classFor(l)}>{l + '\n'}</span
			>{/each}</pre>
</div>

<style>
	.diff {
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: hidden;
	}
	.path {
		padding: 0.3rem 0.6rem;
		background: var(--surface-2);
		border-bottom: 1px solid var(--border);
		font-size: 0.85em;
	}
	.lines {
		margin: 0;
		border: 0;
		border-radius: 0;
		max-height: 320px;
		overflow: auto;
		background: var(--bg);
		padding: 0.4rem 0.6rem;
		font-size: 0.8em;
		white-space: pre;
	}
	.line {
		display: block;
	}
	.add {
		background: rgba(63, 185, 80, 0.15);
		color: var(--success);
	}
	.del {
		background: rgba(248, 81, 73, 0.15);
		color: var(--danger);
	}
	.hunk {
		color: var(--text-muted);
	}
</style>
