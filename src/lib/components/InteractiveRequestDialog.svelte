<script lang="ts">
	import type {
		InteractiveRequestView,
		InteractiveResponse,
		ElicitationSchema,
		ElicitationSchemaField
	} from '$lib/types';

	let {
		request,
		onRespond
	}: {
		request: InteractiveRequestView;
		onRespond: (r: InteractiveResponse) => void;
	} = $props();

	let busy = $state(false);

	async function pick(r: InteractiveResponse) {
		if (busy) return;
		busy = true;
		try {
			await onRespond(r);
		} finally {
			busy = false;
		}
	}

	// --- user_input state ---
	let userInputAnswer = $state('');

	// --- elicitation state ---
	type FieldValue = string | number | boolean | string[];
	let formValues = $state<Record<string, FieldValue>>({});
	function elicitationSchema(): ElicitationSchema | undefined {
		return request.kind === 'elicitation' ? request.requestedSchema : undefined;
	}
	function ensureDefaults() {
		const schema = elicitationSchema();
		if (!schema) return;
		for (const [key, f] of Object.entries(schema.properties)) {
			if (formValues[key] !== undefined) continue;
			if ('default' in f && f.default !== undefined) {
				formValues[key] = f.default as FieldValue;
			} else if (f.type === 'boolean') {
				formValues[key] = false;
			} else if (f.type === 'array') {
				formValues[key] = [];
			} else {
				formValues[key] = '';
			}
		}
	}
	$effect(() => {
		if (request.kind === 'elicitation') ensureDefaults();
	});

	function fieldLabel(name: string, f: ElicitationSchemaField): string {
		return f.title ?? name;
	}
</script>

<div class="interactive" role="alertdialog" aria-modal="true">
	{#if request.kind === 'permission'}
		<div class="head">Permission required</div>
		<div class="body">
			<div>
				<strong>{request.tool}</strong>
				<span class="muted">({request.permissionKind})</span>
			</div>
			<pre>{request.summary}</pre>
		</div>
		<div class="actions">
			<button
				class="btn"
				disabled={busy}
				onclick={() => pick({ kind: 'permission', decision: 'deny' })}>Deny</button
			>
			<button
				class="btn"
				disabled={busy}
				onclick={() => pick({ kind: 'permission', decision: 'allow-once' })}>Allow once</button
			>
			<button
				class="btn primary"
				disabled={busy}
				onclick={() => pick({ kind: 'permission', decision: 'allow-always' })}>Allow always</button
			>
		</div>
	{:else if request.kind === 'auto_mode_switch'}
		<div class="head">Switch to auto mode?</div>
		<div class="body">
			<p>
				Copilot hit a rate limit
				{#if request.errorCode}<span class="muted">({request.errorCode})</span>{/if}
				and is offering to switch models so this turn can continue.
				{#if request.retryAfterSeconds}
					<br />Otherwise wait ~{request.retryAfterSeconds}s for the limit to reset.
				{/if}
			</p>
		</div>
		<div class="actions">
			<button
				class="btn"
				disabled={busy}
				onclick={() => pick({ kind: 'auto_mode_switch', decision: 'no' })}>No</button
			>
			<button
				class="btn"
				disabled={busy}
				onclick={() => pick({ kind: 'auto_mode_switch', decision: 'yes' })}>Yes, once</button
			>
			<button
				class="btn primary"
				disabled={busy}
				onclick={() => pick({ kind: 'auto_mode_switch', decision: 'yes_always' })}
				>Yes, always</button
			>
		</div>
	{:else if request.kind === 'user_input'}
		<div class="head">The agent has a question</div>
		<div class="body">
			<p>{request.question}</p>
			{#if request.choices && request.choices.length > 0}
				<div class="choices">
					{#each request.choices as choice}
						<button
							type="button"
							class="btn"
							disabled={busy}
							onclick={() => pick({ kind: 'user_input', answer: choice, wasFreeform: false })}
							>{choice}</button
						>
					{/each}
				</div>
			{/if}
			{#if request.allowFreeform}
				<form
					onsubmit={(e) => {
						e.preventDefault();
						pick({ kind: 'user_input', answer: userInputAnswer, wasFreeform: true });
					}}
				>
					<input
						type="text"
						bind:value={userInputAnswer}
						placeholder="Your answer..."
						disabled={busy}
					/>
					<button type="submit" class="btn primary" disabled={busy || !userInputAnswer}>Send</button
					>
				</form>
			{/if}
		</div>
	{:else if request.kind === 'elicitation'}
		<div class="head">{request.elicitationSource ?? 'Agent'} needs information</div>
		<div class="body">
			<p>{request.message}</p>
			{#if request.mode === 'url' && request.url}
				<p>
					<a href={request.url} target="_blank" rel="noopener noreferrer">{request.url}</a>
				</p>
				<div class="actions">
					<button
						class="btn"
						disabled={busy}
						onclick={() => pick({ kind: 'elicitation', action: 'decline' })}>Decline</button
					>
					<button
						class="btn primary"
						disabled={busy}
						onclick={() => pick({ kind: 'elicitation', action: 'accept' })}>Done</button
					>
				</div>
			{:else if request.requestedSchema}
				<form
					onsubmit={(e) => {
						e.preventDefault();
						pick({
							kind: 'elicitation',
							action: 'accept',
							content: { ...formValues }
						});
					}}
				>
					{#each Object.entries(request.requestedSchema.properties) as [name, field] (name)}
						<label class="field">
							<span class="label">{fieldLabel(name, field)}</span>
							{#if field.description}<small class="muted">{field.description}</small>{/if}
							{#if field.type === 'boolean'}
								<input
									type="checkbox"
									checked={Boolean(formValues[name])}
									onchange={(e) =>
										(formValues[name] = (e.currentTarget as HTMLInputElement).checked)}
								/>
							{:else if field.type === 'string' && field.enum}
								<select
									value={String(formValues[name] ?? '')}
									onchange={(e) =>
										(formValues[name] = (e.currentTarget as HTMLSelectElement).value)}
								>
									{#each field.enum as opt, i}
										<option value={opt}>{field.enumNames?.[i] ?? opt}</option>
									{/each}
								</select>
							{:else if field.type === 'string'}
								<input
									type="text"
									value={String(formValues[name] ?? '')}
									oninput={(e) => (formValues[name] = (e.currentTarget as HTMLInputElement).value)}
								/>
							{:else if field.type === 'number' || field.type === 'integer'}
								<input
									type="number"
									value={Number(formValues[name] ?? 0)}
									oninput={(e) =>
										(formValues[name] = Number((e.currentTarget as HTMLInputElement).value))}
								/>
							{:else}
								<input
									type="text"
									value={String(formValues[name] ?? '')}
									oninput={(e) => (formValues[name] = (e.currentTarget as HTMLInputElement).value)}
								/>
							{/if}
						</label>
					{/each}
					<div class="actions">
						<button
							type="button"
							class="btn"
							disabled={busy}
							onclick={() => pick({ kind: 'elicitation', action: 'cancel' })}>Cancel</button
						>
						<button
							type="button"
							class="btn"
							disabled={busy}
							onclick={() => pick({ kind: 'elicitation', action: 'decline' })}>Decline</button
						>
						<button type="submit" class="btn primary" disabled={busy}>Submit</button>
					</div>
				</form>
			{:else}
				<div class="actions">
					<button
						class="btn"
						disabled={busy}
						onclick={() => pick({ kind: 'elicitation', action: 'decline' })}>Decline</button
					>
					<button
						class="btn primary"
						disabled={busy}
						onclick={() => pick({ kind: 'elicitation', action: 'accept' })}>Accept</button
					>
				</div>
			{/if}
		</div>
	{:else if request.kind === 'exit_plan_mode'}
		<div class="head">Ready to exit plan mode?</div>
		<div class="body">
			<p>{request.summary}</p>
			{#if request.planContent}<pre>{request.planContent}</pre>{/if}
		</div>
		<div class="actions">
			<button
				class="btn"
				disabled={busy}
				onclick={() => pick({ kind: 'exit_plan_mode', approved: false })}>Stay in plan mode</button
			>
			{#each request.actions as action}
				<button
					class="btn"
					class:primary={action === request.recommendedAction}
					disabled={busy}
					onclick={() => pick({ kind: 'exit_plan_mode', approved: true, selectedAction: action })}
					>{action}</button
				>
			{/each}
		</div>
	{:else if request.kind === 'sampling'}
		<div class="head">MCP sampling request</div>
		<div class="body">
			<p>{request.summary}</p>
		</div>
		<div class="actions">
			<button class="btn" disabled={busy} onclick={() => pick({ kind: 'sampling', action: 'ack' })}
				>Dismiss</button
			>
		</div>
	{:else if request.kind === 'mcp_oauth'}
		<div class="head">MCP server authentication</div>
		<div class="body">
			<p>{request.summary}</p>
			{#if request.authorizationUrl}
				<p>
					<a href={request.authorizationUrl} target="_blank" rel="noopener noreferrer"
						>Open authorization URL</a
					>
				</p>
			{/if}
		</div>
		<div class="actions">
			<button class="btn" disabled={busy} onclick={() => pick({ kind: 'mcp_oauth', action: 'ack' })}
				>Dismiss</button
			>
		</div>
	{:else if request.kind === 'external_tool'}
		<div class="head">External tool: {request.toolName}</div>
		<div class="body">
			<p>{request.summary}</p>
		</div>
		<div class="actions">
			<button
				class="btn"
				disabled={busy}
				onclick={() => pick({ kind: 'external_tool', action: 'ack' })}>Dismiss</button
			>
		</div>
	{/if}
</div>

<style>
	.interactive {
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
		flex-wrap: wrap;
	}
	.choices {
		display: flex;
		gap: 0.4rem;
		margin: 0.4rem 0;
		flex-wrap: wrap;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		margin: 0.5rem 0;
	}
	.field .label {
		font-weight: 500;
		font-size: 0.9em;
	}
	form input[type='text'],
	form input[type='number'],
	form select {
		padding: 0.3rem 0.5rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: inherit;
	}
</style>
