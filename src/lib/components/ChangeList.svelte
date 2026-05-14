<script lang="ts">
	import { untrack } from 'svelte';
	import type { ChangeEntry, ChangesResponse } from '$lib/client/file-browser';
	import { STATUS_LABEL, STATUS_COLOR } from '$lib/client/file-browser';
	import DiffStat from './DiffStat.svelte';

	let {
		conversationId,
		selectedPath = null,
		refreshToken = 0,
		onselect,
		onrefresh
	}: {
		conversationId: string;
		selectedPath?: string | null;
		refreshToken?: number;
		onselect?: (entry: ChangeEntry) => void;
		onrefresh?: () => void;
	} = $props();

	let entries = $state<ChangeEntry[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let initialized = $state(true);
	let filter = $state('');

	async function load() {
		loading = true;
		error = null;
		try {
			const res = await fetch(`/api/conversations/${conversationId}/git/changes`);
			if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
			const data = (await res.json()) as ChangesResponse;
			entries = data.entries;
			initialized = data.initialized;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void conversationId;
		void refreshToken;
		untrack(() => {
			entries = [];
			load();
		});
	});

	function refresh() {
		load();
		onrefresh?.();
	}

	const visible = $derived(
		filter ? entries.filter((e) => e.path.toLowerCase().includes(filter.toLowerCase())) : entries
	);

	const totals = $derived.by(() => {
		let added = 0;
		let removed = 0;
		for (const e of entries) {
			if (e.added != null) added += e.added;
			if (e.removed != null) removed += e.removed;
		}
		return { added, removed };
	});
</script>

<div class="change-list">
	<div class="toolbar">
		<input
			type="search"
			placeholder="Filter changed files…"
			bind:value={filter}
			aria-label="Filter changed files"
		/>
		<button class="icon-btn" title="Refresh" onclick={refresh} aria-label="Refresh">↻</button>
	</div>
	{#if error}
		<div class="error">{error}</div>
	{:else if !initialized}
		<div class="muted empty">Not a git repository.</div>
	{:else if loading && entries.length === 0}
		<div class="muted empty">Loading…</div>
	{:else if entries.length === 0}
		<div class="muted empty">Working tree clean.</div>
	{:else}
		<div class="rows">
			<div class="summary muted small">
				<span>
					{entries.length} changed file{entries.length === 1 ? '' : 's'}
				</span>
				<DiffStat added={totals.added} removed={totals.removed} />
			</div>
			{#each visible as e (e.path)}
				<button
					class="row"
					class:selected={selectedPath === e.path}
					onclick={() => onselect?.(e)}
					title={e.origPath ? `${e.origPath} → ${e.path}` : e.path}
				>
					<span class="status-pill" style:color={STATUS_COLOR[e.status]}
						>{STATUS_LABEL[e.status]}</span
					>
					<span class="path">
						{#if e.origPath}<span class="orig">{e.origPath} → </span>{/if}{e.path}
					</span>
					<DiffStat added={e.added} removed={e.removed} compact />
					<span class="flags small muted">
						{#if e.staged && e.unstaged}M{:else if e.staged}staged{:else}unstaged{/if}
					</span>
				</button>
			{:else}
				<div class="muted small empty">No matches.</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.change-list {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		font-size: 0.85em;
	}
	.toolbar {
		display: flex;
		gap: 0.4rem;
		padding: 0.4rem;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
	}
	.toolbar input[type='search'] {
		flex: 1;
		min-width: 0;
		padding: 0.25rem 0.5rem;
		background: var(--bg);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 4px;
		font: inherit;
	}
	.icon-btn {
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 4px;
		color: var(--text);
		cursor: pointer;
		padding: 0.15rem 0.45rem;
	}
	.rows {
		overflow: auto;
		flex: 1;
		min-height: 0;
		padding: 0.25rem 0;
	}
	.summary {
		display: flex;
		gap: 0.5rem;
		align-items: baseline;
		padding: 0.25rem 0.6rem;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		width: 100%;
		text-align: left;
		background: transparent;
		border: 0;
		color: var(--text);
		font: inherit;
		padding: 0.25rem 0.6rem;
		cursor: pointer;
	}
	.row:hover {
		background: var(--surface-2);
	}
	.row.selected {
		background: var(--surface-2);
		outline: 1px solid var(--accent);
		outline-offset: -1px;
	}
	.path {
		flex: 1;
		min-width: 0;
		font-family: var(--mono);
		font-size: 0.92em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.orig {
		color: var(--text-muted);
	}
	.status-pill {
		font-family: var(--mono);
		font-weight: 600;
	}
	.flags {
		flex: 0 0 auto;
	}
	.small {
		font-size: 0.85em;
	}
	.muted {
		color: var(--text-muted);
	}
	.empty {
		padding: 0.6rem;
		font-style: italic;
	}
	.error {
		color: var(--danger);
		padding: 0.5rem 0.7rem;
	}
</style>
