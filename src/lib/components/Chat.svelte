<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import type {
		Conversation,
		ConversationUsage,
		Message,
		PortalEvent,
		PermissionDecision,
		PermissionRequestView
	} from '$lib/types';
	import { streamSse } from '$lib/client/sse';
	import { runResumableStream } from '$lib/client/resumable-stream';
	import Message_ from './Message.svelte';
	import PermissionPrompt from './PermissionPrompt.svelte';
	import ContextMeter from './ContextMeter.svelte';

	let {
		conversation,
		initialMessages,
		initialUsage = null,
		parent = null
	}: {
		conversation: Conversation;
		initialMessages: Message[];
		initialUsage?: ConversationUsage | null;
		parent?: {
			id: string;
			title: string;
			messageId: string | null;
			messageIndex: number | null;
		} | null;
	} = $props();

	let messages = $state<Message[]>([]);
	let title = $state<string>(untrack(() => conversation.title));
	let usage = $state<ConversationUsage | null>(untrack(() => initialUsage));
	let recentCompaction = $state<{ tokensRemoved?: number; messagesRemoved?: number } | null>(null);
	let compactionTimer: ReturnType<typeof setTimeout> | null = null;

	// Child forks of this conversation, keyed by the source message id so
	// the corresponding <Message_> can render a "Forked → ..." badge.
	type ForkInfo = {
		id: string;
		title: string;
		sourceMessageId: string | null;
		createdAt: number;
		archivedAt: number | null;
	};
	let forksByMessage = $state<Record<string, ForkInfo[]>>({});

	async function refreshForks() {
		try {
			const r = await fetch(`/api/conversations/${conversation.id}/forks`);
			if (!r.ok) return;
			const data = (await r.json()) as { forks: ForkInfo[] };
			const map: Record<string, ForkInfo[]> = {};
			for (const f of data.forks) {
				if (!f.sourceMessageId) continue;
				(map[f.sourceMessageId] ??= []).push(f);
			}
			forksByMessage = map;
		} catch {
			/* non-fatal */
		}
	}
	$effect(() => {
		// Reset local message list when the conversation prop changes.
		void conversation.id;
		untrack(() => {
			messages = [...initialMessages];
			title = conversation.title;
			usage = initialUsage;
			recentCompaction = null;
			pinnedToBottom = true;
			hasNewBelow = false;
			forksByMessage = {};
			if (compactionTimer) {
				clearTimeout(compactionTimer);
				compactionTimer = null;
			}
			// Reattach to any in-progress turn so a refresh-mid-stream resumes.
			void resumeIfActive();
			void refreshForks();
		});
	});

	let composer = $state('');
	let streaming = $state(false);
	let pendingPermission = $state<PermissionRequestView | null>(null);
	// Distinguishes a user-initiated stop (don't auto-reconnect) from a
	// network/proxy-induced abort triggered by the stall watchdog.
	let userAborted = false;
	// AbortController for the page-lifecycle (external) abort, used so that
	// the visibilitychange handler can nudge a hung stream.
	let externalAc: AbortController | null = null;
	let scrollEl: HTMLDivElement | undefined;
	let textareaEl: HTMLTextAreaElement | undefined;
	// Sticky-scroll: only auto-scroll if the user is pinned to the bottom.
	// Otherwise, surface a "New messages" pill (Slack-style) so we don't
	// yank them away from content they're reading.
	let pinnedToBottom = $state(true);
	let hasNewBelow = $state(false);
	const STICK_THRESHOLD_PX = 40;

	function isNearBottom(el: HTMLElement): boolean {
		return el.scrollHeight - el.clientHeight - el.scrollTop <= STICK_THRESHOLD_PX;
	}

	function onMessagesScroll() {
		const el = scrollEl;
		if (!el) return;
		const near = isNearBottom(el);
		pinnedToBottom = near;
		if (near) hasNewBelow = false;
	}

	function autoGrow() {
		const el = textareaEl;
		if (!el) return;
		el.style.height = 'auto';
		const max = 260;
		el.style.height = Math.min(el.scrollHeight, max) + 'px';
	}

	$effect(() => {
		// Re-run autoGrow whenever the composer text changes. `tick()` waits
		// for the DOM (including `bind:this`) to settle so the very first
		// run after mount actually has `textareaEl` to measure — without
		// this guard the textarea could fall back to its native rows=1
		// rendering, which differs across browsers and occasionally paints
		// unusually tall.
		void composer;
		tick().then(autoGrow);
	});

	async function scrollToBottom(opts: { force?: boolean } = {}) {
		await tick();
		const el = scrollEl;
		if (!el) return;
		if (opts.force || pinnedToBottom) {
			el.scrollTo({ top: el.scrollHeight });
			pinnedToBottom = true;
			hasNewBelow = false;
		} else {
			hasNewBelow = true;
		}
	}

	function jumpToLatest() {
		const el = scrollEl;
		if (!el) return;
		el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
		pinnedToBottom = true;
		hasNewBelow = false;
	}

	async function runStream(initial: {
		method: string;
		headers?: Record<string, string>;
		body?: string;
	}) {
		externalAc?.abort();
		externalAc = new AbortController();
		const ac = externalAc;
		await runResumableStream<PortalEvent>({
			initial,
			externalSignal: ac.signal,
			isDone: (ev) => ev.type === 'done',
			isUserAborted: () => userAborted,
			onEvent: applyEvent,
			onNetworkError: (e) => {
				applyEvent({
					type: 'error',
					code: 'network',
					message: e instanceof Error ? e.message : String(e)
				});
			},
			connect: (req, args) =>
				streamSse<PortalEvent>(`/api/conversations/${conversation.id}/messages`, {
					method: req.method,
					headers: req.headers,
					body: req.body,
					signal: args.signal,
					onStatus: args.onStatus,
					onActivity: args.onActivity
				})
		});
	}

	async function resumeIfActive() {
		if (streaming) return;
		userAborted = false;
		streaming = true;
		try {
			await runStream({ method: 'GET' });
		} finally {
			streaming = false;
		}
	}

	// When the tab is hidden, browsers may freeze the SSE fetch reader; on
	// return to visibility, kick the connection so we resume cleanly.
	$effect(() => {
		if (typeof document === 'undefined') return;
		const onVisible = () => {
			if (document.visibilityState !== 'visible') return;
			if (streaming) {
				// Force a reconnect by aborting the in-flight request; the
				// resumable loop will reattach via GET on the next iteration.
				externalAc?.abort();
				externalAc = new AbortController();
			} else {
				void resumeIfActive();
			}
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => document.removeEventListener('visibilitychange', onVisible);
	});

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
			case 'message.reasoning': {
				let m = messages.find((x) => x.id === ev.messageId);
				if (!m) {
					// Reasoning can arrive before the first visible token. The
					// bridge opens a message.start in that case, but be defensive
					// in case events arrive out of order on resume/replay.
					m = {
						id: ev.messageId,
						conversationId: conversation.id,
						role: 'assistant',
						content: '',
						status: 'streaming',
						errorCode: null,
						createdAt: Date.now(),
						toolCalls: [],
						fileEdits: [],
						reasoning: ''
					};
					messages.push(m);
				}
				m.reasoning = (m.reasoning ?? '') + ev.text;
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
						endedAt: null,
						textOffset: m.content.length
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
			case 'tool.permission.resolved': {
				// Clear any prompt for this request id. Critical on replay:
				// the original `tool.permission` event lives forever in the
				// turn's event log, so without this signal a refresh or a
				// visibility-driven reconnect would resurrect a dialog the
				// user already answered.
				if (pendingPermission?.requestId === ev.requestId) {
					pendingPermission = null;
				}
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
						createdAt: Date.now(),
						textOffset: m.content.length
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
			case 'conversation.update': {
				if (ev.title && ev.title !== title) {
					title = ev.title;
					// Refresh the layout data so the sidebar reflects the new title.
					void invalidateAll();
				}
				break;
			}
			case 'context.usage': {
				usage = {
					conversationId: conversation.id,
					currentTokens: ev.currentTokens,
					tokenLimit: ev.tokenLimit,
					messagesLength: ev.messagesLength,
					systemTokens: ev.systemTokens ?? null,
					conversationTokens: ev.conversationTokens ?? null,
					toolDefinitionsTokens: ev.toolDefinitionsTokens ?? null,
					updatedAt: Date.now()
				};
				break;
			}
			case 'context.compaction': {
				if (ev.phase === 'complete') {
					recentCompaction = {
						tokensRemoved: ev.tokensRemoved,
						messagesRemoved: ev.messagesRemoved
					};
					if (compactionTimer) clearTimeout(compactionTimer);
					compactionTimer = setTimeout(() => {
						recentCompaction = null;
						compactionTimer = null;
					}, 6000);
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
		scrollToBottom({ force: true });
		userAborted = false;
		try {
			await runStream({
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ content: text })
			});
		} finally {
			streaming = false;
		}
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			// On touch devices (no fine pointer), let Enter insert a newline
			// and require the send button — otherwise mobile users have no
			// way to add newlines.
			const coarse =
				typeof window !== 'undefined' &&
				typeof window.matchMedia === 'function' &&
				window.matchMedia('(pointer: coarse)').matches;
			if (coarse) return;
			e.preventDefault();
			send();
		}
	}

	async function stop() {
		// Tell the server to actually cancel the turn (just aborting the
		// SSE fetch would only detach this client; the turn would keep going).
		userAborted = true;
		try {
			await fetch(`/api/conversations/${conversation.id}/messages`, {
				method: 'DELETE'
			});
		} catch {
			/* ignore */
		}
		externalAc?.abort();
	}

	$effect(() => {
		scrollToBottom();
	});

	// Show a "thinking" indicator while we're awaiting the first token of the
	// next assistant message (i.e., streaming but no in-progress assistant
	// message exists yet, or it exists but has no content and no tool activity).
	const thinking = $derived.by(() => {
		if (!streaming || pendingPermission) return false;
		const last = messages[messages.length - 1];
		if (!last || last.role !== 'assistant') return true;
		const hasContent = last.content.length > 0;
		const hasTools = (last.toolCalls?.length ?? 0) > 0 || (last.fileEdits?.length ?? 0) > 0;
		const hasReasoning = (last.reasoning?.length ?? 0) > 0;
		return !hasContent && !hasTools && !hasReasoning;
	});

	$effect(() => {
		void thinking;
		scrollToBottom();
	});
</script>

<div class="chat">
	<header class="head">
		<div class="head-row">
			<h2>{title}</h2>
			<ContextMeter {usage} {recentCompaction} />
		</div>
		<div class="meta muted">
			<span title={conversation.workdir}>📁 {conversation.workdir}</span>
			{#if conversation.model}<span>· {conversation.model}</span>{/if}
		</div>
		{#if parent}
			<div class="parent-crumb muted">
				<svg
					width="11"
					height="11"
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					stroke-width="1.5"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M6 3l-3 3 3 3" />
					<path d="M3 6h7a3 3 0 013 3v4" />
				</svg>
				<span>Forked from</span>
				<a href={`/conversations/${parent.id}`}>{parent.title}</a>
				{#if parent.messageIndex != null}
					<span>· at message {parent.messageIndex + 1}</span>
				{/if}
			</div>
		{/if}
	</header>

	<div class="messages-wrap">
		<div class="messages" bind:this={scrollEl} onscroll={onMessagesScroll}>
			{#each messages as m (m.id)}
				<Message_
					message={m}
					conversationId={conversation.id}
					forks={forksByMessage[m.id] ?? []}
					onForked={refreshForks}
				/>
			{/each}
			{#if pendingPermission}
				<PermissionPrompt request={pendingPermission} onDecide={decidePermission} />
			{/if}
			{#if thinking}
				<div class="thinking" role="status" aria-live="polite">
					<span class="dot"></span><span class="dot"></span><span class="dot"></span>
					<span class="label muted">Thinking…</span>
				</div>
			{/if}
		</div>
		{#if hasNewBelow && !pinnedToBottom}
			<button
				type="button"
				class="jump-latest"
				onclick={jumpToLatest}
				aria-label="Jump to latest messages"
			>
				New messages
				<svg
					width="12"
					height="12"
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M4 6l4 4 4-4" />
				</svg>
			</button>
		{/if}
	</div>

	<form
		class="composer"
		onsubmit={(e) => {
			e.preventDefault();
			send();
		}}
	>
		<div class="composer-shell" class:is-streaming={streaming}>
			<textarea
				bind:this={textareaEl}
				bind:value={composer}
				onkeydown={onKeydown}
				oninput={autoGrow}
				placeholder="Message Copilot…"
				rows="1"
				disabled={streaming && !pendingPermission}
			></textarea>
			<div class="composer-actions">
				<span class="kbd-hint muted" aria-hidden="true">
					<kbd>Shift</kbd>+<kbd>Enter</kbd> for newline
				</span>
				{#if streaming}
					<button
						class="icon-btn stop"
						type="button"
						onclick={stop}
						title="Stop generating"
						aria-label="Stop generating"
					>
						<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
							<rect x="3" y="3" width="10" height="10" rx="1.5" />
						</svg>
					</button>
				{:else}
					<button
						class="icon-btn send"
						type="submit"
						disabled={!composer.trim()}
						title="Send (Enter)"
						aria-label="Send message"
					>
						<svg
							width="16"
							height="16"
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							stroke-width="1.75"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<path d="M2 8L14 2L9.5 14L8 9L2 8Z" />
						</svg>
					</button>
				{/if}
			</div>
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
	.head-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
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
	.parent-crumb {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		margin-top: 0.15rem;
		font-size: 0.78em;
	}
	.parent-crumb a {
		color: inherit;
		text-decoration: underline;
		text-decoration-color: color-mix(in srgb, currentColor 40%, transparent);
	}
	.parent-crumb a:hover {
		text-decoration-color: currentColor;
	}
	.messages-wrap {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
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
	.jump-latest {
		position: absolute;
		left: 50%;
		bottom: 0.75rem;
		transform: translateX(-50%);
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.35rem 0.7rem;
		font-size: 0.8rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--accent);
		color: var(--accent-text);
		cursor: pointer;
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
		transition:
			filter 0.12s ease,
			transform 0.08s ease;
	}
	.jump-latest:hover {
		filter: brightness(1.08);
	}
	.jump-latest:active {
		transform: translateX(-50%) scale(0.96);
	}
	.jump-latest:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.composer {
		border-top: 1px solid var(--border);
		padding: 0.75rem 1.25rem 1rem;
		display: flex;
		flex-direction: column;
	}
	.composer-shell {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 0.5rem 0.6rem 0.45rem;
		transition:
			border-color 0.15s ease,
			box-shadow 0.15s ease,
			background 0.15s ease;
	}
	.composer-shell:focus-within {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
	}
	.composer-shell.is-streaming {
		background: var(--surface-2);
	}
	.composer-shell textarea {
		width: 100%;
		min-height: 28px;
		max-height: 260px;
		border: none;
		background: transparent;
		padding: 0.3rem 0.25rem;
		resize: none;
		outline: none;
		box-shadow: none;
		line-height: 1.5;
		font-size: 0.95rem;
		/* Browsers that support field-sizing auto-size the textarea to its
		   content without help from JS, eliminating any first-paint flash
		   where the native rows=1 height (which varies between browsers
		   and inherits body line-height before our local rules apply)
		   could render unusually tall. The JS autoGrow below remains the
		   fallback for browsers without support. */
		field-sizing: content;
	}
	.composer-shell textarea:disabled {
		opacity: 0.7;
		cursor: progress;
	}
	.composer-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
	}
	.kbd-hint {
		margin-right: auto;
		font-size: 0.72rem;
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		opacity: 0.75;
		user-select: none;
	}
	.kbd-hint kbd {
		font-family: var(--mono);
		font-size: 0.68rem;
		padding: 0.05rem 0.32rem;
		border: 1px solid var(--border);
		border-bottom-width: 2px;
		border-radius: 4px;
		background: var(--surface-2);
		color: var(--text-muted);
		line-height: 1.2;
	}
	.icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		padding: 0;
		border-radius: 8px;
		border: 1px solid transparent;
		cursor: pointer;
		transition:
			background 0.12s ease,
			color 0.12s ease,
			transform 0.08s ease,
			border-color 0.12s ease;
	}
	.icon-btn:active {
		transform: scale(0.94);
	}
	.icon-btn.send {
		background: var(--accent);
		color: var(--accent-text);
	}
	.icon-btn.send:hover:not(:disabled) {
		filter: brightness(1.08);
	}
	.icon-btn.send:disabled {
		background: var(--surface-2);
		color: var(--text-muted);
		cursor: not-allowed;
		opacity: 0.7;
	}
	.icon-btn.stop {
		background: transparent;
		color: var(--danger);
		border-color: color-mix(in srgb, var(--danger) 45%, transparent);
	}
	.icon-btn.stop:hover {
		background: color-mix(in srgb, var(--danger) 12%, transparent);
	}
	.icon-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	@media (max-width: 480px) {
		.kbd-hint {
			display: none;
		}
	}
	@media (pointer: coarse) {
		.kbd-hint {
			display: none;
		}
	}
	.thinking {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.4rem 0.1rem;
	}
	.thinking .dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--fg, currentColor);
		opacity: 0.35;
		animation: thinking-bounce 1.2s infinite ease-in-out;
	}
	.thinking .dot:nth-child(2) {
		animation-delay: 0.15s;
	}
	.thinking .dot:nth-child(3) {
		animation-delay: 0.3s;
	}
	.thinking .label {
		margin-left: 0.35rem;
		font-size: 0.85em;
	}
	@keyframes thinking-bounce {
		0%,
		80%,
		100% {
			transform: translateY(0);
			opacity: 0.35;
		}
		40% {
			transform: translateY(-3px);
			opacity: 0.9;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.thinking .dot {
			animation: none;
		}
	}
</style>
