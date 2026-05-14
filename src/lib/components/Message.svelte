<script lang="ts">
	import type { Message, ToolCallRecord, FileEditRecord } from '$lib/types';
	import { renderMarkdown } from '$lib/client/markdown';
	import ToolCall from './ToolCall.svelte';
	import DiffView from './DiffView.svelte';
	import ReasoningBlock from './ReasoningBlock.svelte';
	import { goto } from '$app/navigation';

	let { message, conversationId }: { message: Message; conversationId?: string } = $props();

	let editing = $state(false);
	let editText = $state('');
	let submitting = $state(false);
	let errorMsg = $state<string | null>(null);

	// Editing is only possible for persisted user messages (a temporary
	// id like `local-1234` is created optimistically before the server
	// confirms; we can't fork from those). It also requires the parent to
	// pass the conversation id.
	const canEdit = $derived(
		message.role === 'user' &&
			!!conversationId &&
			!message.id.startsWith('local-') &&
			!message.id.startsWith('err-')
	);

	function beginEdit() {
		editText = message.content;
		errorMsg = null;
		editing = true;
	}

	function cancelEdit() {
		editing = false;
		errorMsg = null;
	}

	async function submitEdit() {
		const text = editText.trim();
		if (!text || !conversationId || submitting) return;
		submitting = true;
		errorMsg = null;
		try {
			const r = await fetch(`/api/conversations/${conversationId}/messages/${message.id}/fork`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ content: text })
			});
			if (!r.ok) {
				const body = await r.text();
				errorMsg = body || `Fork failed (${r.status})`;
				return;
			}
			const data = (await r.json()) as { conversationId: string };
			await goto(`/conversations/${data.conversationId}`);
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : String(e);
		} finally {
			submitting = false;
		}
	}

	const reasoningStreaming = $derived(
		message.role === 'assistant' &&
			message.status === 'streaming' &&
			(message.content?.length ?? 0) === 0
	);

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
		{#if canEdit && !editing}
			<button
				type="button"
				class="edit-btn"
				onclick={beginEdit}
				title="Edit this message and re-run from here in a new conversation"
				aria-label="Edit message and fork"
			>
				<svg
					width="12"
					height="12"
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					stroke-width="1.5"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" />
				</svg>
				Edit
			</button>
		{/if}
	</header>
	<div class="body">
		{#if message.role === 'assistant'}
			{#if message.reasoning}
				<ReasoningBlock
					text={message.reasoning}
					streaming={reasoningStreaming}
					durationMs={message.reasoningDurationMs ?? null}
				/>
			{/if}
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
		{:else if editing}
			<form
				class="edit-form"
				onsubmit={(e) => {
					e.preventDefault();
					submitEdit();
				}}
			>
				<textarea bind:value={editText} rows="3" disabled={submitting} aria-label="Edited message"
				></textarea>
				<div class="edit-actions">
					<span class="hint muted">
						Re-running will create a new conversation with the workdir restored to this point.
					</span>
					<button type="button" onclick={cancelEdit} disabled={submitting}>Cancel</button>
					<button type="submit" class="primary" disabled={submitting || !editText.trim()}>
						{submitting ? 'Forking…' : 'Save & re-run'}
					</button>
				</div>
				{#if errorMsg}
					<p class="err" role="alert">{errorMsg}</p>
				{/if}
			</form>
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
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.role {
		font-weight: 600;
	}
	.status {
		margin-left: 0.5rem;
	}
	.edit-btn {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.15rem 0.45rem;
		font: inherit;
		font-size: 0.72rem;
		text-transform: none;
		letter-spacing: 0;
		border: 1px solid var(--border);
		border-radius: 5px;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		opacity: 0;
		transition:
			opacity 0.12s ease,
			background 0.12s ease,
			color 0.12s ease;
	}
	.msg:hover .edit-btn,
	.edit-btn:focus-visible {
		opacity: 1;
	}
	.edit-btn:hover {
		background: var(--surface);
		color: var(--fg);
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
	.edit-form {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.edit-form textarea {
		width: 100%;
		min-height: 4.5em;
		font: inherit;
		padding: 0.45rem 0.55rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
		color: inherit;
		resize: vertical;
	}
	.edit-form textarea:focus {
		outline: 2px solid var(--accent);
		outline-offset: -1px;
	}
	.edit-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.edit-actions .hint {
		flex: 1;
		font-size: 0.75rem;
		min-width: 12em;
	}
	.edit-actions button {
		padding: 0.3rem 0.7rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
		color: inherit;
		cursor: pointer;
		font-size: 0.85rem;
	}
	.edit-actions button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.edit-actions .primary {
		background: var(--accent);
		color: var(--accent-text);
		border-color: transparent;
	}
	.err {
		margin: 0;
		color: var(--danger);
		font-size: 0.8rem;
	}
</style>
