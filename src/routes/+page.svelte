<script lang="ts">
	import { goto } from '$app/navigation';
	import { invalidateAll } from '$app/navigation';

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
	<h1>Copilot Portal</h1>
	<p class="muted">Start a new conversation, or pick one from the sidebar.</p>
	<button class="btn primary" onclick={newChat} disabled={creating}>
		{creating ? 'Creating…' : '+ New chat'}
	</button>
	{#if error}<p style="color: var(--danger)">{error}</p>{/if}
</div>

<style>
	.home {
		max-width: 540px;
		margin: 10vh auto;
		margin: 10dvh auto;
		padding: 2rem;
		text-align: center;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		align-items: center;
	}
</style>
