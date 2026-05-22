<script lang="ts">
	import Chat from '$lib/components/Chat.svelte';
	import FileBrowser from '$lib/components/FileBrowser.svelte';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();

	type Tab = 'chat' | 'changes' | 'files' | 'commits';
	let tab = $state<Tab>('chat');
</script>

<svelte:head>
	<title>{data.conversation.title} — Copilot Portal</title>
</svelte:head>

<div class="conversation">
	<div class="tabs" role="tablist">
		<button
			role="tab"
			aria-selected={tab === 'chat'}
			class:active={tab === 'chat'}
			onclick={() => (tab = 'chat')}
		>
			Chat
		</button>
		<button
			role="tab"
			aria-selected={tab === 'changes'}
			class:active={tab === 'changes'}
			onclick={() => (tab = 'changes')}
		>
			Changes
		</button>
		<button
			role="tab"
			aria-selected={tab === 'files'}
			class:active={tab === 'files'}
			onclick={() => (tab = 'files')}
		>
			Files
		</button>
		<button
			role="tab"
			aria-selected={tab === 'commits'}
			class:active={tab === 'commits'}
			onclick={() => (tab = 'commits')}
		>
			Commits
		</button>
	</div>
	<div class="tab-body" class:hidden={tab !== 'chat'}>
		<Chat
			conversation={data.conversation}
			initialMessages={data.messages}
			initialUsage={data.contextUsage}
			parent={data.parent}
			initialActiveTurnId={data.activeTurnId}
			initialPendingInteractive={data.pendingInteractive}
		/>
	</div>
	{#if tab !== 'chat'}
		<div class="tab-body">
			<FileBrowser conversationId={data.conversation.id} pane={tab} />
		</div>
	{/if}
</div>

<style>
	.conversation {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}
	.tabs {
		display: flex;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
		flex: 0 0 auto;
	}
	/* On mobile the sidebar toggle is a fixed-position hamburger at top-left;
	   inset the tab strip so it doesn't sit underneath. */
	@media (max-width: 768px) {
		.tabs {
			padding-left: 2.75rem;
		}
	}
	.tabs button {
		background: transparent;
		color: var(--text-muted);
		border: 0;
		border-bottom: 2px solid transparent;
		padding: var(--space-2) var(--space-4);
		cursor: pointer;
		font: inherit;
	}
	.tabs button.active {
		color: var(--text);
		border-bottom-color: var(--accent);
	}
	.tab-body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.tab-body.hidden {
		display: none;
	}
</style>
