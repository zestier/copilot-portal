<script lang="ts">
	import { untrack } from 'svelte';
	import type { HeadStatus } from '$lib/client/file-browser';

	let {
		conversationId,
		refreshToken = 0
	}: {
		conversationId: string;
		refreshToken?: number;
	} = $props();

	let head = $state<HeadStatus | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(false);

	async function load() {
		loading = true;
		error = null;
		try {
			const res = await fetch(`/api/conversations/${conversationId}/git/status`);
			if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
			head = (await res.json()).status;
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
			head = null;
			load();
		});
	});
</script>

<div class="git-status" aria-label="Git status">
	{#if error}
		<span class="error small">{error}</span>
	{:else if head === null}
		<span class="muted small">{loading ? 'Loading…' : ''}</span>
	{:else if head.initialized === false}
		<span class="muted small">Not a git repository</span>
	{:else}
		<div class="row1">
			<span class="branch" title={head.detached ? 'Detached HEAD' : (head.branch ?? '')}>
				<span class="branch-icon" aria-hidden="true">⎇</span>
				<strong>{head.branch ?? '(detached)'}</strong>
			</span>
			{#if head.shortSha}<code class="sha">@ {head.shortSha}</code>{/if}
		</div>
		<div class="row2 small">
			{#if head.upstream}
				<span class="muted" title={`Tracking ${head.upstream}`}>
					<code>{head.upstream}</code>
				</span>
				{#if head.ahead}<span class="ahead" title="Commits ahead of upstream">↑{head.ahead}</span
					>{/if}
				{#if head.behind}<span class="behind" title="Commits behind upstream">↓{head.behind}</span
					>{/if}
				{#if !head.ahead && !head.behind}<span class="muted in-sync" title="In sync with upstream"
						>·</span
					>{/if}
			{:else}
				<span class="muted">no upstream</span>
			{/if}
			{#if head.dirtyCount > 0}
				<span class="dirty" title="Uncommitted changes in the working tree">
					● {head.dirtyCount} change{head.dirtyCount === 1 ? '' : 's'}
				</span>
			{:else}
				<span class="clean" title="Working tree clean">✓ clean</span>
			{/if}
		</div>
	{/if}
</div>

<style>
	.git-status {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		padding: var(--space-2) var(--space-3);
		background: var(--surface);
		border-bottom: 1px solid var(--border);
		font-size: var(--fs-sm);
	}
	.row1 {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		min-width: 0;
	}
	.branch {
		display: inline-flex;
		align-items: baseline;
		gap: var(--space-1);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.branch-icon {
		color: var(--text-muted);
	}
	.row2 {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: baseline;
	}
	.sha,
	code {
		font-family: var(--mono);
		color: var(--text-muted);
		font-size: var(--fs-sm);
	}
	.small {
		font-size: var(--fs-xs);
	}
	.muted {
		color: var(--text-muted);
	}
	.ahead {
		color: var(--success);
	}
	.behind {
		color: var(--warning);
	}
	.dirty {
		color: var(--warning);
	}
	.clean {
		color: var(--success);
	}
	.error {
		color: var(--danger);
	}
</style>
