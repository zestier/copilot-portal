<script lang="ts">
	import { tick } from 'svelte';
	import type {
		Conversation,
		Message,
		PortalEvent,
		PermissionDecision,
		PermissionRequestView
	} from '$lib/types';
	import { streamSse } from '$lib/client/sse';
	import Message_ from './Message.svelte';
	import PermissionPrompt from './PermissionPrompt.svelte';

	let {
		conversation,
		initialMessages
	}: { conversation: Conversation; initialMessages: Message[] } = $props();

	let messages = $state<Message[]>([]);
	$effect(() => {
		// Reset local message list when the conversation prop changes.
		void conversation.id;
		messages = [...initialMessages];
	});

	let composer = $state('');
	let streaming = $state(false);
	let pendingPermission = $state<PermissionRequestView | null>(null);
	let abortCurrent: (() => void) | null = null;
	let scrollEl: HTMLDivElement | undefined;

	async function scrollToBottom() {
		await tick();
		scrollEl?.scrollTo({ top: scrollEl.scrollHeight });
	}

	function applyEvent(ev: PortalEvent) {
		switch (ev.type) {
			case 'message.start': {
				messages.push({
					id: ev.messageId,
					conversationId: conversation.id,
					role: 'assistant',
					content: '',
					status: 'streaming',
					errorCode: null,
					createdAt: Date.now(),
					toolCalls: [],
					fileEdits: []
				});
				break;
			}
			case 'message.delta': {
				const m = messages.find((x) => x.id === ev.messageId);
				if (m) m.content += ev.text;
				break;
			}
			case 'message.end': {
				const m = messages.find((x) => x.id === ev.messageId);
				if (m) m.status = 'complete';
				break;
			}
			case 'tool.call': {
				const m = messages[messages.length - 1];
				if (m && m.role === 'assistant') {
					(m.toolCalls ??= []).push({
						id: ev.toolCallId,
						messageId: m.id,
						tool: ev.tool,
						argsJson: safeJson(ev.args),
						resultJson: null,
						status: 'pending',
						startedAt: Date.now(),
						endedAt: null
					});
				}
				break;
			}
			case 'tool.result': {
				const m = messages[messages.length - 1];
				const tc = m?.toolCalls?.find((t) => t.id === ev.toolCallId);
				if (tc) {
					tc.status = ev.ok ? 'ok' : 'error';
					tc.resultJson = safeJson(ev.output ?? ev.summary);
					tc.endedAt = Date.now();
				}
				break;
			}
			case 'tool.permission': {
				pendingPermission = {
					requestId: ev.requestId,
					tool: ev.tool,
					kind: ev.kind,
					summary: ev.summary,
					args: ev.args
				};
				break;
			}
			case 'file.edit': {
				const m = messages[messages.length - 1];
				if (m && m.role === 'assistant') {
					(m.fileEdits ??= []).push({
						id: `${m.id}-${(m.fileEdits ?? []).length}`,
						messageId: m.id,
						path: ev.path,
						diff: ev.diff,
						createdAt: Date.now()
					});
				}
				break;
			}
			case 'error': {
				const m = messages[messages.length - 1];
				if (m && m.role === 'assistant') {
					m.status = 'error';
					m.errorCode = ev.code;
					m.content += `\n\n_Error: ${ev.message}_`;
				} else {
					messages.push({
						id: `err-${Date.now()}`,
						conversationId: conversation.id,
						role: 'system',
						content: `Error: ${ev.message}`,
						status: 'error',
						errorCode: ev.code,
						createdAt: Date.now()
					});
				}
				break;
			}
		}
		scrollToBottom();
	}

	function safeJson(v: unknown): string {
		try {
			return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
		} catch {
			return String(v);
		}
	}

	async function decidePermission(d: PermissionDecision) {
		if (!pendingPermission) return;
		const req = pendingPermission;
		pendingPermission = null;
		await fetch(`/api/conversations/${conversation.id}/permissions/${req.requestId}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ decision: d })
		});
	}

	async function send() {
		const text = composer.trim();
		if (!text || streaming) return;
		composer = '';
		streaming = true;
		messages.push({
			id: `local-${Date.now()}`,
			conversationId: conversation.id,
			role: 'user',
			content: text,
			status: 'complete',
			errorCode: null,
			createdAt: Date.now()
		});
		scrollToBottom();
		const ac = new AbortController();
		abortCurrent = () => ac.abort();
		try {
			for await (const ev of streamSse<PortalEvent>(
				`/api/conversations/${conversation.id}/messages`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ content: text }),
					signal: ac.signal
				}
			)) {
				applyEvent(ev);
				if (ev.type === 'done') break;
			}
		} catch (e) {
			applyEvent({
				type: 'error',
				code: 'network',
				message: e instanceof Error ? e.message : String(e)
			});
		} finally {
			streaming = false;
			abortCurrent = null;
		}
	}

	function onKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
			e.preventDefault();
			send();
		}
	}

	function stop() {
		abortCurrent?.();
	}

	$effect(() => {
		scrollToBottom();
	});
</script>

<div class="chat">
	<header class="head">
		<h2>{conversation.title}</h2>
		<div class="meta muted">
			<span title={conversation.workdir}>📁 {conversation.workdir}</span>
			{#if conversation.model}<span>· {conversation.model}</span>{/if}
		</div>
	</header>

	<div class="messages" bind:this={scrollEl}>
		{#each messages as m (m.id)}
			<Message_ message={m} />
		{/each}
		{#if pendingPermission}
			<PermissionPrompt request={pendingPermission} onDecide={decidePermission} />
		{/if}
	</div>

	<form
		class="composer"
		onsubmit={(e) => {
			e.preventDefault();
			send();
		}}
	>
		<textarea
			bind:value={composer}
			onkeydown={onKeydown}
			placeholder="Message Copilot…  (Cmd/Ctrl+Enter to send)"
			rows="3"
			disabled={streaming && !pendingPermission}
		></textarea>
		<div class="actions">
			{#if streaming}
				<button class="btn" type="button" onclick={stop}>Stop</button>
			{/if}
			<button class="btn primary" type="submit" disabled={streaming || !composer.trim()}>
				Send
			</button>
		</div>
	</form>
</div>

<style>
	.chat {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}
	.head {
		padding: 0.75rem 1.25rem;
		border-bottom: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	.head h2 {
		margin: 0;
		font-size: 1.05rem;
	}
	.meta {
		font-size: 0.78em;
		display: flex;
		gap: 0.5rem;
	}
	.messages {
		flex: 1;
		overflow-y: auto;
		padding: 1rem 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		min-height: 0;
	}
	.composer {
		border-top: 1px solid var(--border);
		padding: 0.6rem 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.composer textarea {
		width: 100%;
		min-height: 56px;
		max-height: 260px;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.4rem;
	}
</style>
