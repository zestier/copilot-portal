<script lang="ts">
	import type { PageData } from './$types';
	let { data, form }: { data: PageData; form: { ok?: boolean } | null } = $props();
	const s = $derived(data.settings);
	const copilot = $derived(data.copilot);

	function authLabel(a: typeof copilot.auth): string {
		if (!a.isAuthenticated) return 'Not signed in';
		const who = a.login ? `@${a.login}` : 'signed in';
		const via = a.authType ? ` via ${a.authType}` : '';
		return `${who}${via}`;
	}
</script>

<svelte:head><title>Settings — Copilot Portal</title></svelte:head>

<div class="wrap">
	<h1>Settings</h1>

	<section
		class="copilot-status"
		class:ok={copilot.auth.isAuthenticated}
		class:bad={!copilot.auth.isAuthenticated}
	>
		<div class="row">
			<strong>Copilot:</strong>
			<span>{authLabel(copilot.auth)}</span>
		</div>
		{#if copilot.auth.statusMessage && !copilot.auth.isAuthenticated}
			<div class="muted small">{copilot.auth.statusMessage}</div>
		{/if}
		{#if !copilot.auth.isAuthenticated}
			<div class="muted small">
				Run <code>copilot auth login</code> on the host, or set a per-user token in the database, then
				reload.
			</div>
		{/if}
	</section>

	<form method="POST" action="?/save">
		<label>
			Default model
			{#if copilot.models.length > 0}
				<select name="defaultModel" value={s.defaultModel ?? ''}>
					<option value="">(use server default)</option>
					{#each copilot.models as m (m.id)}
						<option value={m.id}>{m.name} — {m.id}</option>
					{/each}
				</select>
			{:else}
				<input name="defaultModel" value={s.defaultModel ?? ''} placeholder="claude-sonnet-4.5" />
				<span class="muted small">
					Model list unavailable{copilot.error ? `: ${copilot.error}` : ''}.
				</span>
			{/if}
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
	.copilot-status {
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.75rem 1rem;
		margin-bottom: 1.5rem;
	}
	.copilot-status.ok {
		border-color: var(--success, #2a7);
	}
	.copilot-status.bad {
		border-color: var(--danger, #c33);
	}
	.copilot-status .row {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}
	.small {
		font-size: 0.85em;
	}
	code {
		background: var(--surface, #0002);
		padding: 0 0.25rem;
		border-radius: 3px;
	}
</style>
