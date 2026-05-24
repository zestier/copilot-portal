<script lang="ts">
	import { goto } from '$app/navigation';
	import { invalidateAll } from '$app/navigation';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import Alert from '$lib/components/ui/Alert.svelte';

	let creating = $state(false);
	let error = $state<string | null>(null);

	async function newChat() {
		creating = true;
		error = null;
		try {
			const res = await fetch('/api/conversations', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'New chat' })
			});
			if (!res.ok) throw new Error(`Server returned ${res.status}`);
			const body = await res.json();
			await invalidateAll();
			await goto(`/conversations/${body.conversation.id}`);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			creating = false;
		}
	}
</script>

<div class="home">
	<EmptyState
		title="Zestier's AI Portal"
		description="Start a new conversation, or pick one from the sidebar."
		size="lg"
	>
		{#snippet actions()}
			<button class="btn primary" onclick={newChat} disabled={creating}>
				{creating ? 'Creating…' : '+ New chat'}
			</button>
		{/snippet}
	</EmptyState>
	{#if error}
		<div class="error-wrap">
			<Alert kind="error" dismissible ondismiss={() => (error = null)}>{error}</Alert>
		</div>
	{/if}
</div>

<style>
	.home {
		max-width: 540px;
		margin: 10vh auto;
		margin: 10dvh auto;
		padding: var(--space-5);
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.error-wrap {
		width: 100%;
	}
</style>
