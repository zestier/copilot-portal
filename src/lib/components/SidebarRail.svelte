<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/stores';
	import type { User } from '$lib/types';

	let {
		user,
		expanded,
		ontoggle,
		onnavigate
	}: {
		user: User | null;
		expanded: boolean;
		ontoggle: () => void;
		onnavigate?: () => void;
	} = $props();

	let busy = $state(false);

	async function newChat() {
		if (busy) return;
		busy = true;
		try {
			const res = await fetch('/api/conversations', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'New chat' })
			});
			if (!res.ok) return;
			const body = await res.json();
			await invalidateAll();
			onnavigate?.();
			location.href = `/conversations/${body.conversation.id}`;
		} finally {
			busy = false;
		}
	}

	const isSettings = $derived($page.url.pathname.startsWith('/settings'));
	const initials = $derived.by(() => {
		const name = user?.displayName ?? user?.githubLogin ?? '';
		if (!name) return '?';
		const parts = name.trim().split(/\s+/);
		const a = parts[0]?.[0] ?? '';
		const b = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
		return (a + b).toUpperCase() || name[0]!.toUpperCase();
	});
</script>

<nav class="rail" aria-label="Sidebar rail">
	<button
		type="button"
		class="rail-btn"
		title={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
		aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
		aria-expanded={expanded}
		onclick={ontoggle}
	>
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			stroke-width="1.6"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<rect x="2" y="3" width="12" height="10" rx="1.5" />
			<path d="M6 3v10" />
			{#if expanded}
				<path d="M10.5 6.5L8.5 8l2 1.5" />
			{:else}
				<path d="M9.5 6.5l2 1.5-2 1.5" />
			{/if}
		</svg>
	</button>

	<button
		type="button"
		class="rail-btn"
		title="New chat"
		aria-label="New chat"
		onclick={newChat}
		disabled={busy}
	>
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			stroke-width="1.6"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M3.5 11.5l-1 2 2-1 6.5-6.5a1.06 1.06 0 0 0-1.5-1.5L3 11" />
			<path d="M9 4.5l2 2" />
			<path d="M11 11.5h3" />
			<path d="M12.5 10v3" />
		</svg>
	</button>

	<div class="spacer"></div>

	<a
		class="rail-btn"
		class:active={isSettings}
		href="/settings"
		title="Settings"
		aria-label="Settings"
		onclick={onnavigate}
	>
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			stroke-width="1.6"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<circle cx="8" cy="8" r="2" />
			<path
				d="M13 8a5 5 0 0 0-.1-1l1.3-1-1.5-2.6-1.6.6a5 5 0 0 0-1.7-1L9 1.5H7L6.6 3a5 5 0 0 0-1.7 1l-1.6-.6L1.8 6l1.3 1A5 5 0 0 0 3 8a5 5 0 0 0 .1 1l-1.3 1 1.5 2.6 1.6-.6a5 5 0 0 0 1.7 1L7 14.5h2l.4-1.5a5 5 0 0 0 1.7-1l1.6.6 1.5-2.6-1.3-1c.07-.32.1-.66.1-1z"
			/>
		</svg>
	</a>

	{#if user}
		<div class="avatar" title={user.displayName ?? user.githubLogin} aria-hidden="true">
			{initials}
		</div>
	{/if}
</nav>

<style>
	.rail {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-1);
		padding: var(--space-2) 0;
		background: var(--surface);
		border-right: 1px solid var(--border);
		width: 44px;
		flex-shrink: 0;
	}
	.spacer {
		flex: 1;
	}
	.rail-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border-radius: var(--radius-md);
		background: transparent;
		border: 1px solid transparent;
		color: var(--text-muted);
		cursor: pointer;
		padding: 0;
		text-decoration: none;
		transition:
			background 0.12s ease,
			color 0.12s ease;
	}
	.rail-btn:hover:not(:disabled) {
		background: var(--surface-hover);
		color: var(--text);
	}
	.rail-btn:active:not(:disabled) {
		background: var(--surface-active);
	}
	.rail-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.rail-btn.active {
		background: var(--surface-2);
		color: var(--text);
	}
	.avatar {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: var(--fs-xs);
		font-weight: 600;
		background: var(--surface-2);
		color: var(--text-muted);
		user-select: none;
	}
</style>
