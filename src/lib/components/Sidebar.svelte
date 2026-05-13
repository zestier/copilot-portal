<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { Conversation, User } from '$lib/types';

	let {
		conversations,
		user,
		onnavigate
	}: {
		conversations: Conversation[];
		user: User | null;
		onnavigate?: () => void;
	} = $props();

	async function newChat() {
		const res = await fetch('/api/conversations', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title: 'New chat' })
		});
		if (!res.ok) return;
		const body = await res.json();
		await invalidateAll();
		location.href = `/conversations/${body.conversation.id}`;
	}

	async function deleteConv(id: string, ev: Event) {
		ev.preventDefault();
		if (!confirm('Delete this conversation? This cannot be undone.')) return;
		await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
		await invalidateAll();
		if (location.pathname === `/conversations/${id}`) location.href = '/';
	}

	function fmt(ts: number) {
		const d = new Date(ts);
		const diff = (Date.now() - ts) / 1000;
		if (diff < 60) return 'just now';
		if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
		if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
		return d.toLocaleDateString();
	}
</script>

<div class="sidebar-inner">
	<div class="top">
		<button class="btn primary block" onclick={newChat}>+ New chat</button>
	</div>

	<nav class="convs">
		<div class="section-label">Conversations</div>
		{#if conversations.length === 0}
			<p class="muted empty">No conversations yet.</p>
		{/if}
		{#each conversations as c (c.id)}
			<a class="conv" href={`/conversations/${c.id}`} onclick={onnavigate}>
				<div class="title">{c.title}</div>
				<div class="meta muted">{fmt(c.updatedAt)}</div>
				<button
					class="del"
					title="Delete"
					aria-label="Delete conversation"
					onclick={(e) => deleteConv(c.id, e)}>×</button
				>
			</a>
		{/each}
	</nav>

	<div class="bottom">
		<a class="settings-link" href="/settings">⚙ Settings</a>
		{#if user}
			<div class="user muted">
				{user.displayName ?? user.githubLogin}
			</div>
		{/if}
	</div>
</div>

<style>
	.sidebar-inner {
		display: flex;
		flex-direction: column;
		height: 100%;
	}
	.top {
		padding: 1rem;
	}
	.block {
		display: block;
		width: 100%;
	}
	.convs {
		flex: 1;
		overflow-y: auto;
		padding: 0 0.5rem 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	.section-label {
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-muted);
		padding: 0.5rem 0.5rem 0.25rem;
	}
	.empty {
		padding: 0 0.5rem;
		font-size: 0.9em;
	}
	.conv {
		position: relative;
		display: block;
		padding: 0.5rem 0.6rem;
		border-radius: 6px;
		color: inherit;
	}
	.conv:hover {
		background: var(--surface-2);
		text-decoration: none;
	}
	.conv .title {
		font-size: 0.95em;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		padding-right: 1.25rem;
	}
	.conv .meta {
		font-size: 0.75em;
	}
	.del {
		position: absolute;
		right: 0.4rem;
		top: 0.4rem;
		background: transparent;
		border: 0;
		color: var(--text-muted);
		font-size: 1rem;
		line-height: 1;
		opacity: 0;
		cursor: pointer;
	}
	.conv:hover .del {
		opacity: 1;
	}
	.del:hover {
		color: var(--danger);
	}
	.bottom {
		padding: 0.75rem 1rem;
		border-top: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.settings-link {
		color: var(--text);
	}
	.user {
		font-size: 0.8em;
	}
</style>
