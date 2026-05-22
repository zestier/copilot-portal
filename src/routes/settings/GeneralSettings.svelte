<script lang="ts">
	import {
		authLabel,
		formatContextWindow,
		type CopilotStatus,
		type FormResult,
		type SettingsData
	} from './settings-types';
	import type { SessionMode } from '$lib/types';

	const MODE_OPTIONS: { value: SessionMode; label: string; hint: string }[] = [
		{
			value: 'interactive',
			label: 'Interactive',
			hint: 'Normal chat; tools prompt for permission.'
		},
		{
			value: 'plan',
			label: 'Plan',
			hint: 'Plan-only; destructive tools stay blocked until the agent exits plan mode.'
		},
		{
			value: 'autopilot',
			label: 'Autopilot',
			hint: 'The agent can work for longer stretches with less supervision.'
		},
		{
			value: 'best-effort',
			label: 'Best effort',
			hint: 'Autopilot-style execution, but permission prompts auto-reject with feedback.'
		}
	];

	let {
		settings,
		copilot,
		form
	}: {
		settings: SettingsData;
		copilot: CopilotStatus;
		form: FormResult | null;
	} = $props();
</script>

<div
	id="settings-panel-general"
	class="tab-panel general"
	role="tabpanel"
	aria-labelledby="settings-tab-general"
>
	<div class="section-heading">
		<h2>General</h2>
		<p class="muted small">Defaults for new conversations and your portal account.</p>
	</div>

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

	<form method="POST" action="?/save" class="settings-form">
		<label>
			Default model
			{#if copilot.models.length > 0}
				<select name="defaultModel" value={settings.defaultModel ?? ''}>
					<option value="">(use server default)</option>
					{#each copilot.models as m (m.id)}
						<option value={m.id}
							>{m.name} — {m.id} ({formatContextWindow(m.maxContextWindowTokens)})</option
						>
					{/each}
				</select>
			{:else}
				<input
					name="defaultModel"
					value={settings.defaultModel ?? ''}
					placeholder="claude-sonnet-4.5"
				/>
				<span class="muted small">
					Model list unavailable{copilot.error ? `: ${copilot.error}` : ''}.
				</span>
			{/if}
		</label>
		<label>
			Default working directory
			<input
				name="defaultWorkdir"
				value={settings.defaultWorkdir ?? ''}
				placeholder="(blank = PROJECT_ROOT)"
			/>
		</label>
		<label>
			Default conversation mode
			<select name="defaultConversationMode" value={settings.defaultConversationMode}>
				{#each MODE_OPTIONS as opt (opt.value)}
					<option value={opt.value}>{opt.label}</option>
				{/each}
			</select>
			<span class="muted small">
				Applies to newly created conversations. Existing conversations keep their current mode.
				<br />
				{MODE_OPTIONS.find((opt) => opt.value === settings.defaultConversationMode)?.hint}
			</span>
		</label>
		<label>
			Permission policy
			<select name="defaultPolicy" value={settings.defaultPolicy}>
				<option value="prompt"
					>Auto-allow file ops inside the workspace, prompt otherwise (default)</option
				>
				<option value="allow-all">Allow all (dangerous)</option>
				<option value="deny-all">Deny all</option>
			</select>
		</label>
		<label>
			Theme
			<select name="theme" value={settings.theme}>
				<option value="system">System</option>
				<option value="dark">Dark</option>
				<option value="light">Light</option>
			</select>
		</label>

		<div class="form-actions">
			<button class="btn primary" type="submit">Save</button>
			{#if form?.formId === 'save' && form.ok}<span class="ok">Saved.</span>{/if}
			{#if form?.formId === 'save' && form.error}<span class="err">{form.error}</span>{/if}
		</div>
	</form>

	<form method="POST" action="/logout" class="logout-form">
		<button class="btn">Log out</button>
	</form>
</div>

<style>
	.tab-panel {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 1rem;
	}
	.section-heading {
		margin-bottom: 1rem;
	}
	.section-heading h2 {
		margin: 0 0 0.25rem;
		font-size: 1.15rem;
	}
	.section-heading p {
		margin: 0;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		margin-bottom: 1.25rem;
	}
	form input,
	form select {
		width: 100%;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.form-actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-top: 0.25rem;
	}
	.err {
		color: var(--danger, #d33);
	}
	.ok {
		color: var(--success);
		margin-left: 0.5rem;
	}
	.logout-form {
		display: block;
		margin-bottom: 0;
	}
	.copilot-status {
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.75rem 1rem;
		margin-bottom: 1.5rem;
	}
	.copilot-status.ok {
		border-color: var(--success);
	}
	.copilot-status.bad {
		border-color: var(--danger);
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
		background: var(--code-bg);
		padding: 0 0.25rem;
		border-radius: var(--radius-sm);
	}
</style>
