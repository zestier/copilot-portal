<script lang="ts">
	import Alert from '$lib/components/ui/Alert.svelte';
	import type { FormResult, PromptTemplate } from './settings-types';
	import type { PromptTemplateListItem } from '$lib/prompt-templates';

	let {
		builtInTemplates,
		promptTemplates,
		form
	}: {
		builtInTemplates: PromptTemplateListItem[];
		promptTemplates: PromptTemplate[];
		form: FormResult | null;
	} = $props();

	const openTemplates = $derived(promptTemplates.filter((template) => template.status === 'open'));
	const archivedTemplates = $derived(
		promptTemplates.filter((template) => template.status === 'archived')
	);
</script>

<div
	id="settings-panel-prompts"
	class="tab-panel prompts"
	role="tabpanel"
	aria-labelledby="settings-tab-prompts"
>
	<div class="section-heading">
		<h2>Prompts</h2>
		<p class="muted small">
			Save reusable prompt templates for recurring workflows. Built-in templates are always
			available when starting a chat.
		</p>
	</div>

	{#if form?.formId?.includes('PromptTemplate')}
		<Alert kind={form.ok ? 'success' : 'error'}>
			{form.ok ? 'Prompt template saved.' : (form.error ?? 'Prompt template update failed.')}
		</Alert>
	{/if}

	<section aria-labelledby="create-prompt-template-heading" class="card">
		<h3 id="create-prompt-template-heading">Create a custom template</h3>
		<form method="POST" action="?/createPromptTemplate" class="settings-form">
			<label>
				Title
				<input name="title" maxlength="120" required placeholder="Debug production error" />
			</label>
			<label>
				Description
				<input
					name="description"
					maxlength="500"
					placeholder="Triage logs, identify root cause, and propose a fix"
				/>
			</label>
			<label>
				Prompt body
				<textarea
					name="prompt"
					rows="7"
					maxlength="20000"
					required
					placeholder="Describe the recurring task or workflow..."
				></textarea>
			</label>
			<div class="inline-fields">
				<label class="checkbox">
					<input name="pinned" type="checkbox" />
					Pin near the top
				</label>
				<label>
					Order
					<input name="orderIndex" type="number" value="0" />
				</label>
			</div>
			<button class="btn primary" type="submit">Save template</button>
		</form>
	</section>

	<section aria-labelledby="built-in-prompts-heading" class="card">
		<h3 id="built-in-prompts-heading">Built-in templates</h3>
		<div class="template-grid">
			{#each builtInTemplates as template (template.id)}
				<article class="template-card">
					<strong>{template.title}</strong>
					<p class="muted small">{template.description}</p>
				</article>
			{/each}
		</div>
	</section>

	<section aria-labelledby="custom-prompts-heading" class="card">
		<div class="section-row">
			<h3 id="custom-prompts-heading">Your templates</h3>
			<span class="muted small">{openTemplates.length} active</span>
		</div>
		{#if openTemplates.length === 0}
			<p class="muted empty">No custom templates yet.</p>
		{:else}
			<div class="custom-list">
				{#each openTemplates as template (template.id)}
					<details class="custom-template">
						<summary>
							<span>
								<strong>{template.title}</strong>
								<small>{template.description || 'Custom prompt template'}</small>
							</span>
							{#if template.pinned}<span class="pill">Pinned</span>{/if}
						</summary>
						<form method="POST" action="?/updatePromptTemplate" class="settings-form compact">
							<input type="hidden" name="id" value={template.id} />
							<label>
								Title
								<input name="title" maxlength="120" required value={template.title} />
							</label>
							<label>
								Description
								<input name="description" maxlength="500" value={template.description} />
							</label>
							<label>
								Prompt body
								<textarea name="prompt" rows="7" maxlength="20000" required
									>{template.prompt}</textarea
								>
							</label>
							<div class="inline-fields">
								<label class="checkbox">
									<input name="pinned" type="checkbox" checked={template.pinned} />
									Pin near the top
								</label>
								<label>
									Order
									<input name="orderIndex" type="number" value={template.orderIndex} />
								</label>
							</div>
							<div class="actions">
								<button class="btn primary" type="submit">Save changes</button>
								<button class="btn danger" type="submit" form="archive-template-{template.id}">
									Archive
								</button>
							</div>
						</form>
						<form
							id="archive-template-{template.id}"
							method="POST"
							action="?/archivePromptTemplate"
						>
							<input type="hidden" name="id" value={template.id} />
						</form>
					</details>
				{/each}
			</div>
		{/if}
		{#if archivedTemplates.length > 0}
			<details class="archived">
				<summary>Archived templates ({archivedTemplates.length})</summary>
				<ul>
					{#each archivedTemplates as template (template.id)}
						<li>{template.title}</li>
					{/each}
				</ul>
			</details>
		{/if}
	</section>
</div>

<style>
	.prompts {
		display: grid;
		gap: var(--space-4);
	}
	.section-heading h2,
	h3 {
		margin: 0;
	}
	.card {
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--surface);
		padding: var(--space-4);
		display: grid;
		gap: var(--space-3);
	}
	.settings-form {
		display: grid;
		gap: var(--space-3);
	}
	.settings-form.compact {
		margin-top: var(--space-3);
	}
	label {
		display: grid;
		gap: var(--space-1);
	}
	input,
	textarea {
		width: 100%;
	}
	textarea {
		resize: vertical;
	}
	.inline-fields,
	.actions,
	.section-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
	}
	.section-row {
		justify-content: space-between;
	}
	.checkbox {
		display: inline-flex;
		grid-template-columns: auto 1fr;
		align-items: center;
	}
	.checkbox input {
		width: auto;
	}
	.template-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: var(--space-2);
	}
	.template-card,
	.custom-template {
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--surface-2);
		padding: var(--space-3);
	}
	.template-card p {
		margin: var(--space-1) 0 0;
	}
	.custom-list {
		display: grid;
		gap: var(--space-2);
	}
	summary {
		cursor: pointer;
	}
	.custom-template summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}
	.custom-template small {
		display: block;
		color: var(--text-muted);
		margin-top: 0.15rem;
	}
	.pill {
		border: 1px solid var(--accent);
		border-radius: 999px;
		color: var(--accent);
		font-size: var(--fs-xs);
		padding: 0.1rem 0.45rem;
	}
	.empty {
		border: 1px dashed var(--border);
		border-radius: var(--radius-md);
		padding: var(--space-3);
	}
	.archived {
		color: var(--text-muted);
	}
</style>
