<script lang="ts">
	import { parseUnifiedDiff, diffStats } from '$lib/client/diff-parser';

	let { path, diff }: { path: string; diff: string } = $props();
	const parsed = $derived(parseUnifiedDiff(diff));
	const stats = $derived(diffStats(parsed));
	const empty = $derived(parsed.length === 0 || parsed.every((l) => l.kind === 'meta'));

	function fmtNo(n: number | null): string {
		return n == null ? '' : String(n);
	}
</script>

<div class="diff">
	<div class="path-bar">
		<code class="path">{path}</code>
		<span class="stats">
			<span class="added">+{stats.added}</span>
			<span class="removed">−{stats.removed}</span>
		</span>
	</div>
	{#if empty}
		<div class="empty">No textual diff (file may be binary, empty, or unchanged).</div>
	{:else}
		<div class="lines" role="table" aria-label="diff lines">
			{#each parsed as l, i (i)}
				<div class={'line ' + l.kind} role="row">
					<span class="gutter old" role="cell" aria-label="old line number">{fmtNo(l.oldNo)}</span>
					<span class="gutter new" role="cell" aria-label="new line number">{fmtNo(l.newNo)}</span>
					<span class="sign" aria-hidden="true"
						>{l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : l.kind === 'hunk' ? '@' : ' '}</span
					>
					<span class="text" role="cell">{l.text}</span>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.diff {
		display: flex;
		flex-direction: column;
		min-height: 0;
		height: 100%;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg);
		overflow: hidden;
	}
	.path-bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.3rem 0.6rem;
		background: var(--surface-2);
		border-bottom: 1px solid var(--border);
		font-size: 0.85em;
		position: sticky;
		top: 0;
		z-index: 1;
	}
	.path {
		font-family: var(--mono);
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.stats {
		display: inline-flex;
		gap: 0.4rem;
		font-family: var(--mono);
		font-size: 0.95em;
	}
	.added {
		color: var(--success);
	}
	.removed {
		color: var(--danger);
	}
	.empty {
		padding: 0.8rem;
		color: var(--text-muted);
		font-style: italic;
	}
	.lines {
		flex: 1;
		min-height: 0;
		overflow: auto;
		font-family: var(--mono);
		font-size: 0.82em;
		line-height: 1.45;
	}
	.line {
		display: grid;
		grid-template-columns: 3.5em 3.5em 1em 1fr;
		align-items: baseline;
		white-space: pre;
	}
	.gutter {
		text-align: right;
		padding: 0 0.45rem;
		color: var(--text-muted);
		background: var(--surface);
		border-right: 1px solid var(--border);
		user-select: none;
		font-variant-numeric: tabular-nums;
	}
	.gutter.new {
		border-right: 1px solid var(--border);
	}
	.sign {
		text-align: center;
		color: var(--text-muted);
		user-select: none;
	}
	.text {
		padding: 0 0.4rem;
		overflow-wrap: anywhere;
		white-space: pre;
	}
	.line.add {
		background: color-mix(in srgb, var(--success) 12%, transparent);
	}
	.line.add .text,
	.line.add .sign {
		color: var(--success);
	}
	.line.add .gutter {
		background: color-mix(in srgb, var(--success) 20%, transparent);
		color: var(--success);
	}
	.line.del {
		background: color-mix(in srgb, var(--danger) 12%, transparent);
	}
	.line.del .text,
	.line.del .sign {
		color: var(--danger);
	}
	.line.del .gutter {
		background: color-mix(in srgb, var(--danger) 20%, transparent);
		color: var(--danger);
	}
	.line.hunk {
		background: var(--surface);
		color: var(--text-muted);
	}
	.line.hunk .text {
		color: var(--text-muted);
	}
	.line.hunk .sign {
		color: var(--text-muted);
	}
	.line.meta {
		color: var(--text-muted);
		background: var(--surface);
	}
	.line.meta .text {
		color: var(--text-muted);
	}
	.line.nonewline {
		color: var(--text-muted);
		font-style: italic;
	}
</style>
