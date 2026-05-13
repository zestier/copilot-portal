<script lang="ts">
	import { untrack } from 'svelte';
	import type { FsEntry, TreeResponse } from '$lib/client/file-browser';
	import { STATUS_LABEL, STATUS_COLOR } from '$lib/client/file-browser';

	let {
		conversationId,
		selectedPath = null,
		showIgnored = false,
		showHidden = false,
		onselect
	}: {
		conversationId: string;
		selectedPath?: string | null;
		showIgnored?: boolean;
		showHidden?: boolean;
		onselect?: (entry: FsEntry) => void;
	} = $props();

	interface Loaded {
		entries: FsEntry[];
		loading: boolean;
		error: string | null;
		expanded: boolean;
	}

	// Map of dir relPath ("" for root) -> loaded state.
	let dirs = $state<Record<string, Loaded>>({});
	let filter = $state('');
	let refreshToken = $state(0);

	async function loadDir(path: string) {
		const key = path;
		dirs[key] = dirs[key] ?? { entries: [], loading: false, error: null, expanded: true };
		dirs[key].loading = true;
		dirs[key].error = null;
		try {
			const params = new URLSearchParams();
			if (path) params.set('path', path);
			if (showHidden) params.set('hidden', '1');
			if (showIgnored) params.set('ignored', '1');
			const res = await fetch(`/api/conversations/${conversationId}/fs/tree?${params.toString()}`);
			if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
			const data: TreeResponse = await res.json();
			dirs[key] = {
				entries: data.entries,
				loading: false,
				error: null,
				expanded: dirs[key]?.expanded ?? true
			};
		} catch (e) {
			dirs[key] = {
				...(dirs[key] ?? { entries: [], expanded: true }),
				loading: false,
				error: e instanceof Error ? e.message : String(e)
			};
		}
	}

	$effect(() => {
		// Reload root when conversation or toggles change.
		void conversationId;
		void showHidden;
		void showIgnored;
		void refreshToken;
		untrack(() => {
			dirs = {};
			loadDir('');
		});
	});

	export function refresh() {
		refreshToken++;
	}

	async function toggleDir(entry: FsEntry) {
		const key = entry.relPath;
		const existing = dirs[key];
		if (existing) {
			dirs[key] = { ...existing, expanded: !existing.expanded };
			if (dirs[key].expanded && existing.entries.length === 0) {
				await loadDir(key);
			}
		} else {
			dirs[key] = { entries: [], loading: true, error: null, expanded: true };
			await loadDir(key);
		}
	}

	function pickFile(entry: FsEntry) {
		onselect?.(entry);
	}

	function matchesFilter(name: string): boolean {
		if (!filter) return true;
		return name.toLowerCase().includes(filter.toLowerCase());
	}

	function statusBadge(s: FsEntry['status'] | FsEntry['containsChanges']) {
		if (!s) return null;
		return { label: STATUS_LABEL[s], color: STATUS_COLOR[s] };
	}
</script>

<div class="tree-root">
	<div class="toolbar">
		<input type="search" placeholder="Filter…" bind:value={filter} aria-label="Filter file names" />
		<button class="icon-btn" title="Refresh" onclick={() => refresh()} aria-label="Refresh">
			↻
		</button>
	</div>
	{#snippet renderEntries(path: string, depth: number)}
		{@const loaded = dirs[path]}
		{#if loaded?.loading && loaded.entries.length === 0}
			<div class="muted indented" style:--depth={depth}>Loading…</div>
		{:else if loaded?.error}
			<div class="error indented" style:--depth={depth}>{loaded.error}</div>
		{:else if loaded}
			{#each loaded.entries.filter((e) => matchesFilter(e.name)) as entry (entry.relPath)}
				{#if entry.type === 'directory'}
					{@const childLoaded = dirs[entry.relPath]}
					{@const expanded = childLoaded?.expanded ?? false}
					{@const badge = statusBadge(entry.containsChanges)}
					<button
						class="row dir"
						style:--depth={depth}
						class:has-changes={!!entry.containsChanges}
						onclick={() => toggleDir(entry)}
					>
						<span class="caret" class:open={expanded}>▶</span>
						<span class="icon">📁</span>
						<span class="name">{entry.name}</span>
						{#if badge}
							<span class="status-pill" style:color={badge.color}>{badge.label}</span>
						{/if}
					</button>
					{#if expanded}
						{@render renderEntries(entry.relPath, depth + 1)}
					{/if}
				{:else}
					{@const badge = statusBadge(entry.status)}
					{@const sel = selectedPath === entry.relPath}
					<button
						class="row file"
						class:selected={sel}
						class:has-changes={!!entry.status}
						style:--depth={depth}
						onclick={() => pickFile(entry)}
					>
						<span class="caret-spacer"></span>
						<span class="icon">{entry.type === 'symlink' ? '🔗' : '📄'}</span>
						<span class="name">{entry.name}</span>
						{#if badge}
							<span class="status-pill" style:color={badge.color}>{badge.label}</span>
						{/if}
					</button>
				{/if}
			{:else}
				<div class="muted indented" style:--depth={depth}>(empty)</div>
			{/each}
		{/if}
	{/snippet}
	<div class="entries">
		{@render renderEntries('', 0)}
	</div>
</div>

<style>
	.tree-root {
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
	.entries {
		overflow: auto;
		flex: 1;
		min-height: 0;
		padding: 0.25rem 0;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		width: 100%;
		padding: 0.15rem 0.5rem 0.15rem calc(0.5rem + var(--depth, 0) * 0.9rem);
		background: transparent;
		border: 0;
		text-align: left;
		color: var(--text);
		font: inherit;
		cursor: pointer;
		white-space: nowrap;
	}
	.row:hover {
		background: var(--surface-2);
	}
	.row.selected {
		background: var(--surface-2);
		outline: 1px solid var(--accent);
		outline-offset: -1px;
	}
	.caret {
		display: inline-block;
		width: 0.75rem;
		transition: transform 100ms;
		color: var(--text-muted);
		font-size: 0.7em;
	}
	.caret.open {
		transform: rotate(90deg);
	}
	.caret-spacer {
		display: inline-block;
		width: 0.75rem;
	}
	.icon {
		width: 1em;
		text-align: center;
	}
	.name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.has-changes .name {
		color: var(--warning);
	}
	.row.file.has-changes .name {
		color: var(--warning);
	}
	.status-pill {
		font-family: var(--mono);
		font-weight: 600;
		font-size: 0.85em;
		padding: 0 0.25rem;
	}
	.muted {
		color: var(--text-muted);
		font-style: italic;
		padding: 0.15rem 0.5rem 0.15rem calc(0.5rem + var(--depth, 0) * 0.9rem);
	}
	.error {
		color: var(--danger);
		padding: 0.15rem 0.5rem 0.15rem calc(0.5rem + var(--depth, 0) * 0.9rem);
	}
	.indented {
		padding-left: calc(0.5rem + var(--depth, 0) * 0.9rem);
	}
</style>
