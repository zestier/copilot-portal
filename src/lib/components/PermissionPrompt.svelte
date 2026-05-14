<script lang="ts">
	import type { PermissionRequestView, PermissionDecision } from '$lib/types';

	let {
		request,
		onDecide
	}: {
		request: PermissionRequestView;
		onDecide: (d: PermissionDecision) => void;
	} = $props();

	let busy = $state(false);

	async function pick(d: PermissionDecision) {
		if (busy) return;
		busy = true;
		try {
			await onDecide(d);
		} finally {
			busy = false;
		}
	}
</script>

<div class="perm" role="alertdialog" aria-modal="true">
	<div class="head">Permission required</div>
	<div class="body">
		<div>
			<strong>{request.tool}</strong>
			<span class="muted">({request.kind})</span>
		</div>
		<pre>{request.summary}</pre>
	</div>
	<div class="actions">
		<button class="btn" disabled={busy} onclick={() => pick('deny')}>Deny</button>
		<button class="btn" disabled={busy} onclick={() => pick('allow-once')}>Allow once</button>
		<button class="btn primary" disabled={busy} onclick={() => pick('allow-always')}
			>Allow always</button
		>
	</div>
</div>

<style>
	.perm {
		border: 1px solid var(--warning);
		background: var(--warning-bg);
		border-radius: var(--radius-lg);
		padding: var(--space-3) var(--space-4);
	}
	.head {
		font-weight: 600;
		margin-bottom: 0.4rem;
	}
	.body pre {
		background: var(--surface);
		max-height: 200px;
		overflow: auto;
		margin-top: 0.4rem;
		font-size: 0.85em;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.6rem;
		justify-content: flex-end;
	}
</style>
