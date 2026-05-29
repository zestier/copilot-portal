<script lang="ts">
	import type { MemoryHarvestRecord } from '$lib/types';

	let { harvest }: { harvest: MemoryHarvestRecord | null | undefined } = $props();

	type HarvestChange = {
		action?: string;
		status?: string;
		reason?: string;
		memoryId?: string;
		requested?: unknown;
		before?: unknown;
		after?: unknown;
		archived?: number;
	};

	const changed = $derived(
		harvest ? harvest.writes + harvest.updates + harvest.forgets + (harvest.sceneEnded ? 1 : 0) : 0
	);
	const changes = $derived(parseJsonArray<HarvestChange>(harvest?.changesJson));
	const parsedJson = $derived(formatJson(harvest?.parsedJson));
	const label = $derived.by(() => {
		if (!harvest) return '';
		if (harvest.status === 'applied') return `Background memory harvest · applied ${changed}`;
		return `Background memory harvest · ${harvest.status}`;
	});
	const detail = $derived.by(() => {
		if (!harvest) return '';
		switch (harvest.status) {
			case 'pending':
				return 'Harvesting memories in the background; this will update when it finishes.';
			case 'skipped':
				return harvest.reason === 'assistant_reply_too_short'
					? 'Skipped because the assistant reply was too short to harvest.'
					: 'Skipped before running.';
			case 'empty':
				return 'Harvester ran and chose not to write, update, forget, or close any memory.';
			case 'applied':
				return 'Harvester applied memory-bank changes from this reply.';
			case 'failed':
				return 'Harvester failed; details are shown below.';
		}
	});

	function parseJsonArray<T>(raw: string | null | undefined): T[] {
		if (!raw) return [];
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? (parsed as T[]) : [];
		} catch {
			return [];
		}
	}

	function formatJson(raw: string | null | undefined): string | null {
		if (!raw) return null;
		try {
			return JSON.stringify(JSON.parse(raw), null, 2);
		} catch {
			return raw;
		}
	}

	function formatUnknown(value: unknown): string {
		if (value === undefined || value === null) return '';
		return JSON.stringify(value, null, 2);
	}
</script>

{#if harvest}
	<details class="memory-harvest" data-status={harvest.status}>
		<summary title="Show memory harvesting outcome after this assistant reply">
			<svg
				width="12"
				height="12"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				stroke-width="1.6"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<path d="M4 4h8" />
				<path d="M4 8h8" />
				<path d="M4 12h5" />
				<path d="M12 10l1.5 1.5L12 13" />
			</svg>
			<span>{label}</span>
		</summary>
		<div class="harvest-body">
			<p>{detail}</p>
			<dl>
				<div>
					<dt>Writes</dt>
					<dd>{harvest.writes}</dd>
				</div>
				<div>
					<dt>Updates</dt>
					<dd>{harvest.updates}</dd>
				</div>
				<div>
					<dt>Forgets</dt>
					<dd>{harvest.forgets}</dd>
				</div>
				<div>
					<dt>Scene ended</dt>
					<dd>{harvest.sceneEnded ? 'yes' : 'no'}</dd>
				</div>
			</dl>
			{#if harvest.reason}
				<div class="meta"><span>Reason</span><code>{harvest.reason}</code></div>
			{/if}
			{#if harvest.error}
				<pre>{harvest.error}</pre>
			{/if}
			{#if changes.length > 0}
				<section>
					<h4>Applied change log</h4>
					<ul class="changes">
						{#each changes as change, index (`${change.action ?? 'change'}:${change.memoryId ?? index}`)}
							<li>
								<div class="change-title">
									<span>{change.action ?? 'change'}</span>
									<span class:applied={change.status === 'applied'}
										>{change.status ?? 'unknown'}</span
									>
									{#if change.reason}
										<code>{change.reason}</code>
									{/if}
								</div>
								{#if change.memoryId}
									<div class="meta"><span>Memory</span><code>{change.memoryId}</code></div>
								{/if}
								{#if change.archived !== undefined}
									<div class="meta">
										<span>Archived scene memories</span><code>{change.archived}</code>
									</div>
								{/if}
								{#if change.requested}
									<details class="nested">
										<summary>Requested</summary>
										<pre>{formatUnknown(change.requested)}</pre>
									</details>
								{/if}
								{#if change.before}
									<details class="nested">
										<summary>Before</summary>
										<pre>{formatUnknown(change.before)}</pre>
									</details>
								{/if}
								{#if change.after}
									<details class="nested">
										<summary>After</summary>
										<pre>{formatUnknown(change.after)}</pre>
									</details>
								{/if}
							</li>
						{/each}
					</ul>
				</section>
			{/if}
			{#if harvest.prompt || harvest.reasoning || harvest.response || parsedJson}
				<section>
					<h4>Harvester diagnostics</h4>
					{#if harvest.prompt}
						<details class="nested">
							<summary>Input prompt</summary>
							<pre>{harvest.prompt}</pre>
						</details>
					{/if}
					{#if harvest.reasoning}
						<details class="nested">
							<summary>Thinking</summary>
							<pre>{harvest.reasoning}</pre>
						</details>
					{/if}
					{#if harvest.response}
						<details class="nested">
							<summary>Model output</summary>
							<pre>{harvest.response}</pre>
						</details>
					{/if}
					{#if parsedJson}
						<details class="nested">
							<summary>Parsed JSON</summary>
							<pre>{parsedJson}</pre>
						</details>
					{/if}
				</section>
			{/if}
		</div>
	</details>
{/if}

<style>
	.memory-harvest {
		margin: 0.1rem 0 0.35rem;
		font-size: var(--fs-xs);
		color: var(--text-muted);
	}
	summary {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		width: fit-content;
		padding: 0.1rem 0.45rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface-2);
		cursor: pointer;
		list-style: none;
		transition:
			background 0.12s ease,
			color 0.12s ease;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	summary:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
	summary:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.memory-harvest[data-status='failed'] summary {
		border-color: color-mix(in srgb, var(--danger) 40%, var(--border));
	}
	.memory-harvest[data-status='applied'] summary {
		border-color: color-mix(in srgb, var(--success) 40%, var(--border));
	}
	.harvest-body {
		margin-top: var(--space-2);
		padding: var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--surface-2);
	}
	p {
		margin: 0 0 var(--space-2);
	}
	dl {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
		gap: var(--space-2);
		margin: 0;
	}
	dt {
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-size: 0.85em;
	}
	dd {
		margin: 0.1rem 0 0;
		color: var(--text);
	}
	.meta {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}
	section {
		margin-top: var(--space-3);
		padding-top: var(--space-3);
		border-top: 1px solid var(--border);
	}
	h4 {
		margin: 0 0 var(--space-2);
		font-size: var(--fs-xs);
		color: var(--text);
	}
	.changes {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.changes li {
		padding: var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
	}
	.change-title {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-size: 0.85em;
	}
	.change-title span:first-child {
		color: var(--text);
		font-weight: 600;
	}
	.applied {
		color: var(--success);
	}
	.nested {
		margin-top: var(--space-2);
	}
	.nested summary {
		padding: 0;
		border: 0;
		border-radius: 0;
		background: transparent;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-size: 0.85em;
	}
	code {
		font-size: 0.9em;
		color: var(--text-muted);
	}
	pre {
		margin: var(--space-2) 0 0;
		max-height: 12rem;
		overflow: auto;
		white-space: pre-wrap;
		word-break: break-word;
		font-size: var(--code-fs);
		color: var(--text-muted);
	}
</style>
