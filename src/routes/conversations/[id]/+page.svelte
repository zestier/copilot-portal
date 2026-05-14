<script lang="ts">
	import Chat from '$lib/components/Chat.svelte';
	import FileBrowser from '$lib/components/FileBrowser.svelte';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();

	type Tab = 'chat' | 'files';
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
			aria-selected={tab === 'files'}
			class:active={tab === 'files'}
			onclick={() => (tab = 'files')}
		>
			Files
		</button>
	</div>
	<div class="tab-body" class:hidden={tab !== 'chat'}>
		<Chat
			conversation={data.conversation}
			initialMessages={data.messages}
			initialUsage={data.contextUsage}
			parent={data.parent}
			initialActiveTurnId={data.activeTurnId}
		/>
	</div>
	{#if tab === 'files'}
		<div class="tab-body">
			<FileBrowser conversationId={data.conversation.id} />
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
	/* Inset past the fixed-position hamburger toggle in +layout.svelte when the
	   sidebar is collapsed (desktop or mobile) so it doesn't cover the Chat tab. */
	:global(.layout.collapsed) .tabs {
		padding-left: 2.75rem;
	}
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
		padding: 0.5rem 1rem;
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
