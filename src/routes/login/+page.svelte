<script lang="ts">
	import type { PageData } from './$types';
	let { data, form }: { data: PageData; form: { ok?: boolean; error?: string } | null } = $props();
</script>

<div class="login">
	<h1>Copilot Portal</h1>

	{#if data.mode === 'github'}
		<p>Sign in with GitHub to continue.</p>
		<a class="btn primary" href={data.authorizeUrl}>Sign in with GitHub</a>
	{:else if data.mode === 'shared-secret'}
		<form method="POST">
			<label for="secret">Shared secret</label>
			<input id="secret" name="secret" type="password" autocomplete="current-password" required />
			{#if form?.error}<p class="err">{form.error}</p>{/if}
			<button class="btn primary" type="submit">Sign in</button>
		</form>
	{:else}
		<p>Auth is disabled (local mode). You should already be signed in.</p>
		<a class="btn" href="/">Continue</a>
	{/if}
</div>

<style>
	.login {
		max-width: 360px;
		margin: 10vh auto;
		padding: 2rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		font-family: system-ui;
	}
	.btn {
		display: inline-block;
		padding: 0.6rem 1rem;
		border-radius: 6px;
		border: 1px solid var(--border, #444);
		background: var(--surface, #1c1f24);
		color: inherit;
		text-decoration: none;
		cursor: pointer;
	}
	.btn.primary {
		background: var(--accent, #1f6feb);
		border-color: transparent;
		color: #fff;
	}
	input {
		width: 100%;
		padding: 0.5rem 0.6rem;
		border-radius: 6px;
		border: 1px solid var(--border, #444);
		background: var(--bg, #0d1117);
		color: inherit;
	}
	.err {
		color: #f85149;
		font-size: 0.9em;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
</style>
