<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import type {
		Conversation,
		ConversationUsage,
		Message,
		PortalEvent,
		InteractiveRequestView,
		InteractiveResponse,
		ProviderCapabilities
	} from '$lib/types';
	import Message_ from './Message.svelte';
	import InteractiveRequestDialog from './InteractiveRequestDialog.svelte';
	import ChatHeader from './ChatHeader.svelte';
	import Composer from './Composer.svelte';
	import ThinkingIndicator from './ThinkingIndicator.svelte';
	import { addInteractive, removeInteractive } from '$lib/client/interactive-queue';
	import {
		findToolCallRecord,
		shouldRefreshTicketsAfterToolResult
	} from '$lib/client/ticket-tool-refresh';

	let {
		conversation,
		initialMessages,
		initialUsage = null,
		parent = null,
		initialActiveTurnId = null,
		initialPendingInteractive = [],
		initialComposer = '',
		providerCapabilities,
		providerDisplayName,
		chatPlaceholder
	}: {
		conversation: Conversation;
		providerCapabilities: ProviderCapabilities;
		providerDisplayName: string;
		chatPlaceholder: string;
		initialMessages: Message[];
		initialUsage?: ConversationUsage | null;
		parent?: {
			id: string;
			title: string;
			messageId: string | null;
			messageIndex: number | null;
		} | null;
		initialActiveTurnId?: string | null;
		initialPendingInteractive?: InteractiveRequestView[];
		initialComposer?: string;
	} = $props();

	let messages = $state<Message[]>([]);
	let title = $state<string>(untrack(() => conversation.title));
	let sessionMode = $state<Conversation['mode']>(untrack(() => conversation.mode));
	let approveAllTools = $state<boolean>(untrack(() => conversation.approveAllTools));
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
			// Tear down any stream attached to the previous conversation
			// before we swap state — otherwise its events would land in
			// the new conversation's `messages` array.
			closeStream();
			messages = [...initialMessages];
			title = conversation.title;
			sessionMode = conversation.mode;
			approveAllTools = conversation.approveAllTools;
			usage = initialUsage;
			composer = initialComposer;
			recentCompaction = null;
			pinnedToBottom = true;
			hasNewBelow = false;
			forksByMessage = {};
			pendingInteractive = [...initialPendingInteractive];
			if (compactionTimer) {
				clearTimeout(compactionTimer);
				compactionTimer = null;
			}
			// Reattach the EventSource to any in-progress turn so a
			// refresh-mid-stream resumes seamlessly.
			if (initialActiveTurnId) {
				attachStream(initialActiveTurnId);
			}
			void refreshForks();
		});
	});

	let composer = $state(untrack(() => initialComposer));
	let streaming = $state(false);
	// Queue of outstanding permission requests. The SDK can fire multiple
	// `onPermissionRequest` callbacks concurrently (parallel tool calls),
	// so we must surface them all — a single slot would let later events
	// clobber earlier ones, stranding the earlier requests on the server.
	let pendingInteractive = $state<InteractiveRequestView[]>(
		untrack(() => [...initialPendingInteractive])
	);
	// Active EventSource for the in-flight turn (if any). null when idle.
	// Holding a reference here lets `stop()` close it on user-cancel and
	// lets the conversation-prop $effect tear it down on navigation.
	let eventSource: EventSource | null = null;
	// Id of the turn we're currently streaming. Tracked separately because
	// EventSource owns its own URL; we need the id for DELETE on cancel.
	let activeTurnId: string | null = null;
	let scrollEl: HTMLDivElement | undefined;
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

	// Open an EventSource against an in-flight turn and route its events
	// through `applyEvent`. The browser owns the connection lifecycle:
	//   - Auto-reconnects on transient drops (locked phone, sleeping
	//     radio, proxy idle close).
	//   - Sends `Last-Event-ID` on reconnect so the server replays only
	//     events we haven't seen yet.
	// We only need to handle two terminal cases ourselves:
	//   1. `done` portal event → turn finished cleanly. Close the stream.
	//   2. Network error with `readyState === CLOSED` → server refused
	//      reconnect (typically 410 Gone: turn no longer in registry).
	//      Refetch persisted messages so the UI catches up, then stop.
	function attachStream(turnId: string) {
		closeStream();
		activeTurnId = turnId;
		streaming = true;

		const es = new EventSource(`/api/conversations/${conversation.id}/turns/${turnId}/stream`);
		eventSource = es;

		es.onmessage = (msg) => {
			let ev: PortalEvent;
			try {
				ev = JSON.parse(msg.data) as PortalEvent;
			} catch {
				return;
			}
			applyEvent(ev);
			if (ev.type === 'done') {
				closeStream();
			}
		};
		es.onerror = () => {
			// Browser closed the connection permanently (e.g. 410 from
			// our stream endpoint: turn id unknown because the grace
			// window expired during a long phone lock). We're then
			// authoritatively desynced from the DB — refetch and stop.
			// Transient errors keep `readyState === CONNECTING` and the
			// browser retries automatically; we leave those alone.
			if (es.readyState === EventSource.CLOSED) {
				closeStream();
				void refreshMessages();
			}
		};
	}

	function closeStream() {
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
		activeTurnId = null;
		streaming = false;
	}

	// Pull the latest persisted messages for this conversation and replace
	// local state. Used as a recovery path when the EventSource closes
	// without a `done` (e.g. 410 Gone after grace expiry) so the UI
	// doesn't strand mid-stream content forever.
	async function refreshMessages() {
		try {
			const r = await fetch(`/api/conversations/${conversation.id}`);
			if (!r.ok) return;
			const data = (await r.json()) as {
				messages: Message[];
				activeTurnId: string | null;
				pendingInteractive?: InteractiveRequestView[];
			};
			messages = data.messages;
			// Rehydrate outstanding prompts from the authoritative server
			// list. Previously we cleared this unconditionally, which meant
			// any transient SSE drop stranded the dialog even though the
			// server's `pending` map still held the request — and the agent
			// would only see a response after the (formerly 10-minute)
			// timeout fired. Now we just snap to whatever the server says.
			pendingInteractive = data.pendingInteractive ?? [];
			await scrollToBottom();
			// If a new turn became active between events (unlikely but
			// possible from another tab), attach to it.
			if (data.activeTurnId && !eventSource) {
				attachStream(data.activeTurnId);
			}
		} catch {
			/* non-fatal */
		}
	}

	async function handleToolRerunStarted(turnId: string) {
		streaming = true;
		await refreshMessages();
		if (!eventSource) attachStream(turnId);
	}

	function handleInlineEdited(messageId: string, content: string, turnId: string) {
		const idx = messages.findIndex((m) => m.id === messageId);
		if (idx >= 0) {
			messages = messages.slice(0, idx + 1);
			messages[idx] = {
				...messages[idx],
				content,
				status: 'complete',
				errorCode: null
			};
		} else {
			void refreshMessages();
		}
		pendingInteractive = [];
		usage = null;
		streaming = true;
		attachStream(turnId);
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
					fileEdits: [],
					reasoningBlocks: []
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
						reasoningBlocks: []
					};
					messages.push(m);
				}
				const blocks = (m.reasoningBlocks ??= []);
				let seg = blocks.find((b) => b.id === ev.segmentId);
				if (!seg) {
					const isChild = !!ev.parentToolCallId;
					seg = {
						id: ev.segmentId,
						messageId: m.id,
						segmentIndex: blocks.length,
						text: '',
						textOffset: isChild ? null : m.content.length,
						startedAt: Date.now(),
						durationMs: null,
						parentToolCallId: ev.parentToolCallId ?? null
					};
					blocks.push(seg);
				}
				seg.text += ev.text;
				break;
			}
			case 'message.reasoning.end': {
				const m = messages.find((x) => x.id === ev.messageId);
				const seg = m?.reasoningBlocks?.find((b) => b.id === ev.segmentId);
				if (seg) seg.durationMs = ev.durationMs;
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
					const isChild = !!ev.parentToolCallId;
					(m.toolCalls ??= []).push({
						id: ev.toolCallId,
						messageId: m.id,
						tool: ev.tool,
						argsJson: safeJson(ev.args),
						resultJson: null,
						status: 'pending',
						startedAt: Date.now(),
						endedAt: null,
						textOffset: isChild ? null : m.content.length,
						parentToolCallId: ev.parentToolCallId ?? null
					});
				}
				break;
			}
			case 'tool.result': {
				const tc = findToolCallRecord(messages, ev.toolCallId);
				if (tc) {
					tc.status = ev.ok ? 'ok' : 'error';
					tc.resultJson = safeJson(ev.output ?? ev.summary);
					tc.endedAt = Date.now();
					// Drop ephemeral streaming state — final result supersedes it.
					tc.partialOutput = undefined;
					tc.progressMessage = undefined;
				}
				if (shouldRefreshTicketsAfterToolResult(tc, ev)) {
					void invalidateAll();
				}
				break;
			}
			case 'subagent.lifecycle': {
				const tc = findToolCallRecord(messages, ev.toolCallId);
				if (tc) {
					tc.backgroundAgentStatus = ev.status;
					tc.backgroundAgentId = ev.agentId;
					if (ev.status === 'running') {
						tc.backgroundAgentStartedAt ??= Date.now();
						tc.backgroundAgentEndedAt = null;
					} else {
						tc.backgroundAgentEndedAt = Date.now();
					}
				}
				break;
			}
			case 'tool.partial_output': {
				const tc = findToolCallRecord(messages, ev.toolCallId);
				// The SDK emits cumulative snapshots of the tool's stdout/stderr
				// buffer (not deltas) so progress bars and carriage-return redraws
				// render correctly — each event already contains everything that
				// came before, so we replace rather than append.
				if (tc) tc.partialOutput = ev.output;
				break;
			}
			case 'tool.progress': {
				const tc = findToolCallRecord(messages, ev.toolCallId);
				if (tc) tc.progressMessage = ev.message;
				break;
			}
			case 'interactive.request': {
				pendingInteractive = addInteractive(pendingInteractive, ev.request);
				break;
			}
			case 'interactive.resolved': {
				// Drop the matching prompt. Critical on replay: the original
				// `interactive.request` event lives forever in the turn's event
				// log, so without this signal a refresh or a visibility-driven
				// reconnect would resurrect a dialog the user already answered.
				pendingInteractive = removeInteractive(pendingInteractive, ev.requestId);
				break;
			}
			case 'file.edit': {
				const m = messages[messages.length - 1];
				if (m && m.role === 'assistant') {
					const isChild = !!ev.parentToolCallId;
					(m.fileEdits ??= []).push({
						id: `${m.id}-${(m.fileEdits ?? []).length}`,
						messageId: m.id,
						path: ev.path,
						diff: ev.diff,
						createdAt: Date.now(),
						textOffset: isChild ? null : m.content.length,
						parentToolCallId: ev.parentToolCallId ?? null
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
			case 'session.settings': {
				// Server-driven settings change (typically the agent flipping
				// itself out of plan mode via exit-plan-mode). Mirror it into
				// our local state so the header reflects reality without a
				// page refresh.
				if (ev.mode !== undefined) sessionMode = ev.mode;
				if (ev.approveAllTools !== undefined) approveAllTools = ev.approveAllTools;
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

	async function respondInteractive(requestId: string, response: InteractiveResponse) {
		if (!pendingInteractive.some((p) => p.requestId === requestId)) return;
		// Optimistically drop the prompt; the server will also emit an
		// `interactive.resolved` which is a no-op once removed.
		pendingInteractive = removeInteractive(pendingInteractive, requestId);
		await fetch(`/api/conversations/${conversation.id}/interactive/${requestId}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(response)
		});
	}

	async function send() {
		const text = composer.trim();
		if (!text || streaming) return;
		composer = '';
		const localMessageId = `local-${Date.now()}`;
		messages.push({
			id: localMessageId,
			conversationId: conversation.id,
			role: 'user',
			content: text,
			status: 'complete',
			errorCode: null,
			createdAt: Date.now()
		});
		scrollToBottom({ force: true });

		// Start the turn server-side, then attach an EventSource to its
		// stream. The POST is just a "create" — all event delivery flows
		// through the GET stream so reconnects (browser-driven) just work.
		streaming = true;
		try {
			const r = await fetch(`/api/conversations/${conversation.id}/turns`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ content: text })
			});
			if (!r.ok) {
				let msg = `HTTP ${r.status}`;
				try {
					const body = (await r.json()) as { message?: string };
					if (body.message) msg = body.message;
				} catch {
					/* ignore */
				}
				streaming = false;
				applyEvent({ type: 'error', code: 'start_failed', message: msg });
				return;
			}
			const { turnId, userMessageId } = (await r.json()) as {
				turnId: string;
				userMessageId: string;
			};
			messages = messages.map((m) => (m.id === localMessageId ? { ...m, id: userMessageId } : m));
			attachStream(turnId);
		} catch (e) {
			streaming = false;
			applyEvent({
				type: 'error',
				code: 'network',
				message: e instanceof Error ? e.message : String(e)
			});
		}
	}

	async function stop() {
		// Tell the server to actually cancel the turn (just closing the
		// EventSource would only detach this client; the turn would keep
		// running). Then close the stream locally.
		const turnId = activeTurnId;
		if (turnId) {
			try {
				await fetch(`/api/conversations/${conversation.id}/turns/${turnId}`, { method: 'DELETE' });
			} catch {
				/* ignore */
			}
		}
		closeStream();
	}

	$effect(() => {
		scrollToBottom();
	});

	// Show a "thinking" indicator while we're awaiting the first token of the
	// next assistant message (i.e., streaming but no in-progress assistant
	// message exists yet, or it exists but has no content and no tool activity).
	const thinking = $derived.by(() => {
		if (!streaming || pendingInteractive.length > 0) return false;
		const last = messages[messages.length - 1];
		if (!last || last.role !== 'assistant') return true;
		const hasContent = last.content.length > 0;
		const hasTools = (last.toolCalls?.length ?? 0) > 0 || (last.fileEdits?.length ?? 0) > 0;
		const hasReasoning = (last.reasoningBlocks?.length ?? 0) > 0;
		return !hasContent && !hasTools && !hasReasoning;
	});

	$effect(() => {
		void thinking;
		scrollToBottom();
	});
</script>

<div class="chat">
	<ChatHeader
		{title}
		{conversation}
		{providerCapabilities}
		{providerDisplayName}
		{parent}
		{usage}
		{recentCompaction}
		mode={sessionMode}
		{approveAllTools}
		onSettingsChange={(patch) => {
			if (patch.mode !== undefined) sessionMode = patch.mode;
			if (patch.approveAllTools !== undefined) approveAllTools = patch.approveAllTools;
		}}
	/>

	<div class="messages-wrap">
		<div class="messages" bind:this={scrollEl} onscroll={onMessagesScroll}>
			{#each messages as m (m.id)}
				<Message_
					message={m}
					conversationId={conversation.id}
					forks={forksByMessage[m.id] ?? []}
					conversationIdle={!streaming}
					onForked={refreshForks}
					onInlineEdited={handleInlineEdited}
					onToolRerunStarted={handleToolRerunStarted}
				/>
			{/each}
			{#each pendingInteractive as p (p.requestId)}
				<InteractiveRequestDialog
					request={p}
					onRespond={(r) => respondInteractive(p.requestId, r)}
				/>
			{/each}
			{#if thinking}
				<ThinkingIndicator />
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

	<Composer
		bind:value={composer}
		{streaming}
		inputDisabled={streaming && pendingInteractive.length === 0}
		placeholder={chatPlaceholder}
		onSend={send}
		onStop={stop}
	/>
</div>

<style>
	.chat {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
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
		padding: var(--space-4) var(--space-5);
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		min-height: 0;
	}
	.jump-latest {
		position: absolute;
		left: 50%;
		bottom: var(--space-3);
		transform: translateX(-50%);
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: 0.35rem 0.7rem;
		font-size: var(--fs-sm);
		border-radius: var(--radius-pill);
		border: 1px solid var(--border);
		background: var(--accent);
		color: var(--accent-text);
		cursor: pointer;
		box-shadow: var(--shadow-2);
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
</style>
