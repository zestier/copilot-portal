<script lang="ts">
	import type { PageData } from './$types';
	let { data, form }: { data: PageData; form: { ok?: boolean } | null } = $props();
	const s = $derived(data.settings);
</script>

<svelte:head><title>Settings — Copilot Portal</title></svelte:head>

<div class="wrap">
	<h1>Settings</h1>

	<form method="POST" action="?/save">
		<label>
			Default model
			<input name="defaultModel" value={s.defaultModel ?? ''} placeholder="claude-sonnet-4.5" />
		</label>
		<label>
			Default working directory
			<input
				name="defaultWorkdir"
				value={s.defaultWorkdir ?? ''}
				placeholder="(blank = per-conversation under DATA_DIR/workspaces)"
			/>
		</label>
		<label>
			Permission policy
			<select name="defaultPolicy" value={s.defaultPolicy}>
				<option value="prompt">Prompt for non-read tools (default)</option>
				<option value="allow-readonly">Auto-allow read-only tools</option>
				<option value="allow-all">Allow all (dangerous)</option>
				<option value="deny-all">Deny all</option>
			</select>
		</label>
		<label>
			Theme
			<select name="theme" value={s.theme}>
				<option value="dark">Dark</option>
				<option value="light">Light</option>
			</select>
		</label>

		<button class="btn primary" type="submit">Save</button>
		{#if form?.ok}<span class="ok">Saved.</span>{/if}
	</form>

	<form method="POST" action="/logout">
		<button class="btn">Log out</button>
	</form>
</div>

<style>
	.wrap {
		max-width: 540px;
		margin: 3rem auto;
		padding: 0 1rem;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		margin-bottom: 2rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.ok {
		color: var(--success);
		margin-left: 0.5rem;
	}
</style>
