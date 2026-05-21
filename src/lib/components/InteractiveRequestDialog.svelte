<script lang="ts">
	import type {
		InteractiveRequestView,
		InteractiveResponse,
		ElicitationSchema,
		ElicitationSchemaField,
		PermissionGrantScope
	} from '$lib/types';
	import { deriveScopeKey } from '$lib/permissions/scope-key';

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

	// Pretty-print permission `args` so the user can see exactly what the
	// tool will receive. The SDK's permission summary often collapses to
	// just a file name or command, hiding flags / payloads that matter.
	function formatArgs(args: unknown): string | null {
		if (args === null || args === undefined) return null;
		if (typeof args === 'string') return args.length > 0 ? args : null;
		try {
			const s = JSON.stringify(args, null, 2);
			return s && s !== '{}' && s !== '[]' ? s : null;
		} catch {
			return String(args);
		}
	}

	// --- permission scope picker state ---
	//
	// Four scope choices, narrowest first. Default to the narrowest
	// available so a reflex click on "Allow always" doesn't blanket-grant
	// the tool. The two narrowest options require a derivable scopeKey;
	// without one (e.g. an unfamiliar permission kind) we fall back to
	// "any-kind".
	type ScopeChoice = 'this-exact' | 'tool-kind' | 'tool-any' | 'everything';
	let scopeChoice = $state<ScopeChoice>('tool-kind');
	let expiryChoice = $state<'forever' | '1h' | '1d'>('forever');

	const HOUR_MS = 60 * 60 * 1000;
	const DAY_MS = 24 * HOUR_MS;

	const permissionScopeKey = $derived(
		request.kind === 'permission'
			? (deriveScopeKey(request.permissionKind, {
					fullCommandText: undefined,
					fileName: undefined,
					args: request.args
				}) ?? deriveFromSummary(request))
			: null
	);

	// SDK already collapsed scope into `summary`; for shell that's the full
	// command, for write/edit/read that's the file path. Use it as a
	// fallback scopeKey when the structured args path didn't yield one.
	function deriveFromSummary(
		req: Extract<InteractiveRequestView, { kind: 'permission' }>
	): string | null {
		const s = typeof req.summary === 'string' ? req.summary.trim() : '';
		return s.length > 0 && s !== req.tool ? s : null;
	}

	$effect(() => {
		if (request.kind !== 'permission') return;
		// Auto-select the narrowest scope we can support.
		scopeChoice = permissionScopeKey ? 'this-exact' : 'tool-kind';
	});

	function buildScope(): PermissionGrantScope | undefined {
		if (request.kind !== 'permission') return undefined;
		switch (scopeChoice) {
			case 'this-exact':
				return permissionScopeKey
					? { permissionKind: request.permissionKind, pattern: permissionScopeKey }
					: { permissionKind: request.permissionKind, pattern: null };
			case 'tool-kind':
				return { permissionKind: request.permissionKind, pattern: null };
			case 'tool-any':
				return { permissionKind: null, pattern: null };
			case 'everything':
				// Sentinel: omit scope entirely, server interprets as "no
				// kind/pattern restriction" but the row is still keyed on the
				// requested tool. This matches the legacy "Allow always"
				// semantics exactly.
				return undefined;
		}
	}

	function buildExpiry(): number | undefined {
		switch (expiryChoice) {
			case '1h':
				return HOUR_MS;
			case '1d':
				return DAY_MS;
			case 'forever':
			default:
				return undefined;
		}
	}

	function pickAlways(decision: 'allow-always' | 'deny-always') {
		pick({
			kind: 'permission',
			decision,
			scope: buildScope(),
			expiresInMs: buildExpiry()
		});
	}

	function scopeOptionLabel(choice: ScopeChoice): string {
		if (request.kind !== 'permission') return choice;
		const tool = request.tool;
		const kind = request.permissionKind;
		switch (choice) {
			case 'this-exact':
				return permissionScopeKey
					? `Just this exact ${kind || 'request'}`
					: `Just this exact ${kind || 'request'} (unavailable)`;
			case 'tool-kind':
				return `Any ${tool} (${kind}) request`;
			case 'tool-any':
				return `Any ${tool} request, regardless of kind`;
			case 'everything':
				return `Any tool request (matches legacy "Allow always")`;
		}
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
			{#if formatArgs(request.args)}
				<details class="args">
					<summary>Arguments</summary>
					<pre>{formatArgs(request.args)}</pre>
				</details>
			{/if}

			<details class="grant-scope">
				<summary>Remember this decision (optional)</summary>
				<div class="scope-body">
					<fieldset class="scope-group">
						<legend>Scope</legend>
						{#each ['this-exact', 'tool-kind', 'tool-any', 'everything'] as choice (choice)}
							{@const c = choice as typeof scopeChoice}
							<label class="scope-option">
								<input
									type="radio"
									name="perm-scope"
									value={c}
									checked={scopeChoice === c}
									disabled={c === 'this-exact' && !permissionScopeKey}
									onchange={() => (scopeChoice = c)}
								/>
								{scopeOptionLabel(c)}
							</label>
						{/each}
						{#if scopeChoice === 'this-exact' && permissionScopeKey}
							<div class="muted small">Matches pattern: <code>{permissionScopeKey}</code></div>
						{/if}
					</fieldset>
					<label class="expiry">
						Expires:
						<select
							value={expiryChoice}
							onchange={(e) =>
								(expiryChoice = (e.currentTarget as HTMLSelectElement).value as
									| 'forever'
									| '1h'
									| '1d')}
						>
							<option value="forever">Never</option>
							<option value="1h">In 1 hour</option>
							<option value="1d">In 1 day</option>
						</select>
					</label>
				</div>
			</details>
		</div>
		<div class="actions">
			<button
				class="btn"
				disabled={busy}
				onclick={() => pickAlways('deny-always')}
				title="Deny this and any matching future requests">Deny always</button
			>
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
				onclick={() => pickAlways('allow-always')}
				title="Allow this and any matching future requests">Allow always</button
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
	.body details.args {
		margin-top: 0.4rem;
		font-size: 0.85em;
	}
	.body details.args > summary {
		cursor: pointer;
		opacity: 0.8;
	}
	.body details.args pre {
		margin-top: 0.3rem;
		max-height: 240px;
	}
	.body details.grant-scope {
		margin-top: 0.6rem;
		padding: 0.4rem 0.5rem;
		border: 1px dashed var(--border);
		border-radius: var(--radius-sm);
		font-size: 0.85em;
	}
	.body details.grant-scope > summary {
		cursor: pointer;
		opacity: 0.85;
	}
	.scope-body {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}
	.scope-group {
		border: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.scope-group legend {
		font-weight: 600;
		padding: 0 0 0.2rem;
	}
	.scope-option {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-weight: normal;
	}
	.scope-option:has(input[type='radio']:disabled) {
		opacity: 0.5;
	}
	.expiry {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.expiry select {
		padding: 0.2rem 0.4rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: inherit;
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
