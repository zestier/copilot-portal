<script lang="ts">
	import { splitUnifiedDiffByFile } from '$lib/client/diff-synth';
	import { parseUnifiedDiff, diffStats } from '$lib/client/diff-parser';

	let {
		path = 'diff',
		diff,
		showLineNumbers = true,
		collapsible = false
	}: { path?: string; diff: string; showLineNumbers?: boolean; collapsible?: boolean } = $props();

	const chunks = $derived.by(() => {
		const split = splitUnifiedDiffByFile(diff, path);
		return split.length > 0 ? split : [{ path, diff }];
	});
	let collapsedFiles = $state<Record<string, boolean>>({});

	function fmtNo(n: number | null): string {
		return n == null ? '' : String(n);
	}

	function chunkKey(chunkPath: string, chunkIndex: number): string {
		return `${chunkPath}:${chunkIndex}`;
	}

	function toggleCollapsed(key: string) {
		collapsedFiles = { ...collapsedFiles, [key]: !collapsedFiles[key] };
	}
</script>

<div class="diff-set">
	{#each chunks as chunk, chunkIndex (chunk.path + ':' + chunkIndex)}
		{@const key = chunkKey(chunk.path, chunkIndex)}
		{@const collapsed = collapsible && collapsedFiles[key] === true}
		{@const parsed = parseUnifiedDiff(chunk.diff)}
		{@const stats = diffStats(parsed)}
		{@const empty = parsed.length === 0 || parsed.every((l) => l.kind === 'meta')}
		<div class="diff" class:collapsed>
			<div class="path-bar">
				{#if collapsible}
					<button
						type="button"
						class="collapse-toggle"
						aria-expanded={!collapsed}
						aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${chunk.path}`}
						onclick={() => toggleCollapsed(key)}
					>
						<span class="chevron" class:open={!collapsed} aria-hidden="true">▸</span>
					</button>
				{/if}
				<code class="path">{chunk.path}</code>
				<span class="stats">
					<span class="added">+{stats.added}</span>
					<span class="removed">−{stats.removed}</span>
				</span>
			</div>
			{#if !collapsed}
				{#if empty}
					<div class="empty">No textual diff (file may be binary, empty, or unchanged).</div>
				{:else}
					<div
						class="lines"
						class:no-gutter={!showLineNumbers}
						role="table"
						aria-label="diff lines"
					>
						<div class="rows">
							{#each parsed as l, i (i)}
								{#if l.kind === 'hunk' && !showLineNumbers}
									<!-- Suppress the @@ -L,N +L,N @@ header when we don't trust the
									     line ranges (e.g. for diffs synthesized from edit args
									     without full-file context). -->
								{:else}
									<div class={'line ' + l.kind} role="row">
										{#if showLineNumbers}
											<span class="gutter" role="cell" aria-label="line number"
												>{fmtNo(l.newNo ?? l.oldNo)}</span
											>
										{/if}
										<span class="sign" aria-hidden="true"
											>{l.kind === 'add'
												? '+'
												: l.kind === 'del'
													? '-'
													: l.kind === 'hunk'
														? '@'
														: ' '}</span
										>
										<span class="text" role="cell">{l.text}</span>
									</div>
								{/if}
							{/each}
						</div>
					</div>
				{/if}
			{/if}
		</div>
	{/each}
</div>

<style>
	.diff-set {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-height: 0;
	}
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
	.collapsed .path-bar {
		border-bottom: 0;
	}
	.collapse-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.25rem;
		height: 1.25rem;
		padding: 0;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		flex: none;
	}
	.collapse-toggle:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
	.chevron {
		transition: transform 0.12s ease;
	}
	.chevron.open {
		transform: rotate(90deg);
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
	.rows {
		width: max-content;
		min-width: 100%;
	}
	.line {
		display: grid;
		grid-template-columns: 3.5em 1em max-content;
		align-items: baseline;
		white-space: pre;
	}
	.no-gutter .line {
		grid-template-columns: 1em max-content;
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
	.line.add .sign,
	.line.add .text {
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
	.line.del .sign,
	.line.del .text {
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
