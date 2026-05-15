<script lang="ts">
	import type { Conversation, ConversationUsage } from '$lib/types';
	import ContextMeter from './ContextMeter.svelte';

	let {
		title,
		conversation,
		parent = null,
		usage = null,
		recentCompaction = null
	}: {
		title: string;
		conversation: Conversation;
		parent?: {
			id: string;
			title: string;
			messageId: string | null;
			messageIndex: number | null;
		} | null;
		usage?: ConversationUsage | null;
		recentCompaction?: { tokensRemoved?: number; messagesRemoved?: number } | null;
	} = $props();

	let expanded = $state(false);

	const miniPct = $derived.by(() => {
		if (!usage || usage.tokenLimit <= 0) return 0;
		return Math.min(100, (usage.currentTokens / usage.tokenLimit) * 100);
	});
	const miniLevel = $derived.by<'low' | 'mid' | 'high'>(() => {
		if (miniPct >= 90) return 'high';
		if (miniPct >= 70) return 'mid';
		return 'low';
	});
</script>

<header class="chat-header" class:expanded>
	<button
		type="button"
		class="chat-header-row"
		onclick={() => (expanded = !expanded)}
		aria-expanded={expanded}
		aria-controls="chat-header-details"
	>
		<span class="title-wrap"><h2>{title}</h2></span>
		{#if usage}
			<span
				class="mini-meter"
				data-level={miniLevel}
				aria-hidden="true"
				title={`${usage.currentTokens.toLocaleString()} / ${usage.tokenLimit.toLocaleString()} tokens`}
			>
				<span class="mini-fill" style="width: {miniPct}%"></span>
			</span>
		{/if}
		<svg
			class="chevron"
			width="12"
			height="12"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M4 6l4 4 4-4" />
		</svg>
	</button>
	<div class="chat-header-details" id="chat-header-details">
		<div class="details-inner">
			<div class="details-body">
				<dl class="header-meta">
					{#if conversation.model}
						<dt>Model</dt>
						<dd>{conversation.model}</dd>
					{/if}
					<dt>Workdir</dt>
					<dd class="mono">{conversation.workdir}</dd>
					<dt>ID</dt>
					<dd class="mono">{conversation.id}</dd>
				</dl>
				{#if parent}
					<div class="parent-crumb">
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
				<ContextMeter {usage} {recentCompaction} />
			</div>
		</div>
	</div>
</header>

<style>
	.chat-header {
		border-bottom: 1px solid var(--border);
	}
	.chat-header-row {
		width: 100%;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-5);
		background: transparent;
		border: 0;
		cursor: pointer;
		text-align: left;
		color: inherit;
		font: inherit;
		transition: background 0.12s ease;
	}
	.chat-header-row:hover {
		background: var(--surface-2);
	}
	.chat-header-row:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.title-wrap {
		flex: 1;
		min-width: 0;
	}
	.title-wrap h2 {
		margin: 0;
		font-size: var(--fs-lg);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mini-meter {
		flex: 0 0 auto;
		position: relative;
		width: 72px;
		height: 6px;
		border-radius: 3px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		overflow: hidden;
	}
	.mini-fill {
		position: absolute;
		inset: 0 auto 0 0;
		background: var(--success);
		opacity: 0.6;
		transition: width 240ms ease-out;
	}
	.mini-meter[data-level='mid'] .mini-fill {
		background: var(--warning);
	}
	.mini-meter[data-level='high'] .mini-fill {
		background: var(--danger);
	}
	.chevron {
		flex: 0 0 auto;
		opacity: 0.6;
		transition: transform 160ms ease;
	}
	.chat-header.expanded .chevron {
		transform: rotate(180deg);
	}
	.chat-header-details {
		display: grid;
		grid-template-rows: 0fr;
		transition: grid-template-rows 160ms ease;
	}
	.chat-header.expanded .chat-header-details {
		grid-template-rows: 1fr;
	}
	.details-inner {
		min-height: 0;
		overflow: hidden;
	}
	.details-body {
		padding: var(--space-1) var(--space-5) var(--space-3);
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		font-size: var(--fs-xs);
	}
	.header-meta {
		display: grid;
		grid-template-columns: auto 1fr;
		column-gap: var(--space-3);
		row-gap: var(--space-1);
		margin: 0;
	}
	.header-meta dt {
		opacity: 0.6;
	}
	.header-meta dd {
		margin: 0;
		word-break: break-all;
	}
	.mono {
		font-family: var(--mono);
	}
	.parent-crumb {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		flex-wrap: wrap;
	}
	.parent-crumb a {
		color: inherit;
		text-decoration: underline;
		text-decoration-color: color-mix(in srgb, currentColor 40%, transparent);
	}
	.parent-crumb a:hover {
		text-decoration-color: currentColor;
	}
	@media (prefers-reduced-motion: reduce) {
		.chat-header-details,
		.chevron,
		.mini-fill {
			transition: none;
		}
	}
</style>
