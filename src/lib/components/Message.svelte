<script lang="ts">
	import type { Message } from '$lib/types';
	import { renderMarkdown } from '$lib/client/markdown';
	import ToolCall from './ToolCall.svelte';
	import DiffView from './DiffView.svelte';

	let { message }: { message: Message } = $props();

	const html = $derived(
		message.role === 'assistant' ? renderMarkdown(message.content || '') : null
	);
</script>

<article class="msg" data-role={message.role}>
	<header>
		<span class="role">{message.role}</span>
		{#if message.status !== 'complete' && message.status !== 'streaming'}
			<span class="status muted">({message.status})</span>
		{/if}
	</header>
	<div class="body">
		{#if message.role === 'assistant'}
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			{@html html}
		{:else}
			<pre class="user-text">{message.content}</pre>
		{/if}
	</div>
	{#if message.toolCalls && message.toolCalls.length}
		<div class="tool-list">
			{#each message.toolCalls as tc (tc.id)}
				<ToolCall toolCall={tc} />
			{/each}
		</div>
	{/if}
	{#if message.fileEdits && message.fileEdits.length}
		<div class="edit-list">
			{#each message.fileEdits as fe (fe.id)}
				<DiffView path={fe.path} diff={fe.diff} />
			{/each}
		</div>
	{/if}
</article>

<style>
	.msg {
		padding: 0.75rem 1rem;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--surface);
	}
	.msg[data-role='user'] {
		background: var(--surface-2);
	}
	.msg[data-role='system'] {
		background: transparent;
		border-style: dashed;
		opacity: 0.85;
	}
	header {
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
		margin-bottom: 0.4rem;
	}
	.role {
		font-weight: 600;
	}
	.status {
		margin-left: 0.5rem;
	}
	.body :global(p:first-child) {
		margin-top: 0;
	}
	.body :global(p:last-child) {
		margin-bottom: 0;
	}
	.user-text {
		background: transparent;
		border: 0;
		padding: 0;
		font-family: var(--font);
		white-space: pre-wrap;
		word-break: break-word;
		font-size: 1em;
	}
	.tool-list,
	.edit-list {
		margin-top: 0.6rem;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
</style>
