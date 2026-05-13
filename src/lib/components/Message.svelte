<script lang="ts">
	import type { Message, ToolCallRecord, FileEditRecord } from '$lib/types';
	import { renderMarkdown } from '$lib/client/markdown';
	import ToolCall from './ToolCall.svelte';
	import DiffView from './DiffView.svelte';

	let { message }: { message: Message } = $props();

	type Part =
		| { kind: 'text'; html: string }
		| { kind: 'tool'; tool: ToolCallRecord }
		| { kind: 'edit'; edit: FileEditRecord };

	const parts = $derived.by<Part[]>(() => {
		if (message.role !== 'assistant') return [];
		const content = message.content ?? '';
		const tools = message.toolCalls ?? [];
		const edits = message.fileEdits ?? [];

		// Anything without an explicit offset is rendered after all text
		// (legacy rows persisted before interleaving was tracked).
		const trailingTools: ToolCallRecord[] = [];
		const trailingEdits: FileEditRecord[] = [];

		type Anchor =
			| { offset: number; order: number; kind: 'tool'; tool: ToolCallRecord }
			| { offset: number; order: number; kind: 'edit'; edit: FileEditRecord };
		const anchors: Anchor[] = [];
		let order = 0;
		for (const t of tools) {
			if (t.textOffset == null) trailingTools.push(t);
			else
				anchors.push({
					offset: Math.min(t.textOffset, content.length),
					order: order++,
					kind: 'tool',
					tool: t
				});
		}
		for (const e of edits) {
			if (e.textOffset == null) trailingEdits.push(e);
			else
				anchors.push({
					offset: Math.min(e.textOffset, content.length),
					order: order++,
					kind: 'edit',
					edit: e
				});
		}
		anchors.sort((a, b) => a.offset - b.offset || a.order - b.order);

		const out: Part[] = [];
		let cursor = 0;
		for (const a of anchors) {
			if (a.offset > cursor) {
				out.push({ kind: 'text', html: renderMarkdown(content.slice(cursor, a.offset)) });
				cursor = a.offset;
			}
			if (a.kind === 'tool') out.push({ kind: 'tool', tool: a.tool });
			else out.push({ kind: 'edit', edit: a.edit });
		}
		if (cursor < content.length) {
			out.push({ kind: 'text', html: renderMarkdown(content.slice(cursor)) });
		}
		for (const t of trailingTools) out.push({ kind: 'tool', tool: t });
		for (const e of trailingEdits) out.push({ kind: 'edit', edit: e });
		return out;
	});
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
			{#each parts as p, i (i)}
				{#if p.kind === 'text'}
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					<div class="text-part">{@html p.html}</div>
				{:else if p.kind === 'tool'}
					<ToolCall toolCall={p.tool} />
				{:else}
					<DiffView path={p.edit.path} diff={p.edit.diff} />
				{/if}
			{/each}
		{:else}
			<pre class="user-text">{message.content}</pre>
		{/if}
	</div>
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
	.body {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
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
</style>
