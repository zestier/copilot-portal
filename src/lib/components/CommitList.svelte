<script lang="ts">
	import { untrack } from 'svelte';
	import type { LogEntry, HeadStatus } from '$lib/client/file-browser';

	let {
		conversationId,
		selectedSha = null,
		onselect
	}: {
		conversationId: string;
		selectedSha?: string | null;
		onselect?: (sha: string) => void;
	} = $props();

	let head = $state<HeadStatus | null>(null);
	let commits = $state<LogEntry[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let canLoadMore = $state(true);

	async function loadHead() {
		try {
			const res = await fetch(`/api/conversations/${conversationId}/git/status`);
			if (!res.ok) throw new Error(await res.text());
			head = await res.json();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function loadMore() {
		if (loading || !canLoadMore) return;
		loading = true;
		try {
			const params = new URLSearchParams({
				limit: '20',
				skip: String(commits.length)
			});
			const res = await fetch(`/api/conversations/${conversationId}/git/log?${params.toString()}`);
			if (!res.ok) throw new Error(await res.text());
			const data = (await res.json()) as { initialized: boolean; commits: LogEntry[] };
			if (!data.initialized) {
				canLoadMore = false;
				return;
			}
			commits = [...commits, ...data.commits];
			if (data.commits.length < 20) canLoadMore = false;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void conversationId;
		untrack(() => {
			head = null;
			commits = [];
			canLoadMore = true;
			error = null;
			loadHead();
			loadMore();
		});
	});

	function fmtDate(ms: number): string {
		return new Date(ms).toLocaleString();
	}
</script>

<div class="commit-list">
	<div class="head-info">
		{#if head === null}
			<span class="muted">Loading…</span>
		{:else if head.initialized === false}
			<span class="muted">Not a git repository.</span>
		{:else}
			<div class="branch">
				<strong>{head.branch ?? '(detached)'}</strong>
				{#if head.shortSha}<code class="sha">@ {head.shortSha}</code>{/if}
			</div>
			{#if head.upstream}
				<div class="muted small">
					tracking <code>{head.upstream}</code>
					{#if head.ahead}<span class="ahead">↑{head.ahead}</span>{/if}
					{#if head.behind}<span class="behind">↓{head.behind}</span>{/if}
				</div>
			{/if}
			{#if head.dirtyCount > 0}
				<div class="dirty small">
					{head.dirtyCount} uncommitted change{head.dirtyCount === 1 ? '' : 's'}
				</div>
			{/if}
		{/if}
	</div>
	{#if error}
		<div class="error">{error}</div>
	{/if}
	<div class="commits">
		{#each commits as c (c.sha)}
			<button
				class="commit"
				class:selected={selectedSha === c.sha}
				onclick={() => onselect?.(c.sha)}
				title={c.subject}
			>
				<div class="row1">
					<code class="sha">{c.shortSha}</code>
					<span class="subject">{c.subject}</span>
				</div>
				<div class="row2 small muted">
					<span>{c.author}</span>
					<span>·</span>
					<span>{fmtDate(c.timestamp)}</span>
				</div>
			</button>
		{/each}
		{#if commits.length === 0 && head?.initialized}
			<div class="muted small empty">No commits yet.</div>
		{/if}
		{#if canLoadMore && commits.length > 0}
			<button class="load-more" onclick={loadMore} disabled={loading}>
				{loading ? 'Loading…' : 'Load more'}
			</button>
		{/if}
	</div>
</div>

<style>
	.commit-list {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		font-size: 0.85em;
	}
	.head-info {
		padding: 0.5rem 0.6rem;
		background: var(--surface);
		border-bottom: 1px solid var(--border);
	}
	.branch {
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
	}
	.sha {
		font-family: var(--mono);
		color: var(--text-muted);
		font-size: 0.9em;
	}
	.small {
		font-size: 0.85em;
	}
	.muted {
		color: var(--text-muted);
	}
	.ahead {
		color: var(--success);
		margin-left: 0.3rem;
	}
	.behind {
		color: var(--warning);
		margin-left: 0.3rem;
	}
	.dirty {
		color: var(--warning);
		margin-top: 0.15rem;
	}
	.commits {
		overflow: auto;
		flex: 1;
		min-height: 0;
		padding: 0.25rem 0;
	}
	.commit {
		display: block;
		width: 100%;
		text-align: left;
		background: transparent;
		border: 0;
		border-bottom: 1px solid var(--border);
		color: var(--text);
		font: inherit;
		padding: 0.4rem 0.6rem;
		cursor: pointer;
	}
	.commit:hover {
		background: var(--surface-2);
	}
	.commit.selected {
		background: var(--surface-2);
		outline: 1px solid var(--accent);
		outline-offset: -1px;
	}
	.row1 {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
	}
	.subject {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.row2 {
		margin-top: 0.15rem;
		display: flex;
		gap: 0.35rem;
	}
	.load-more {
		display: block;
		margin: 0.5rem auto;
		padding: 0.3rem 0.8rem;
		background: var(--surface-2);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 4px;
		cursor: pointer;
	}
	.error {
		color: var(--danger);
		padding: 0.4rem 0.6rem;
	}
	.empty {
		padding: 0.6rem;
	}
</style>
