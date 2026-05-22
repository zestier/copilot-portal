<script lang="ts">
	import {
		describeGrantScope,
		formatExpiry,
		formatTime,
		grantScopeLabel,
		type FormResult,
		type PermissionGrant
	} from './settings-types';

	let { grants, form }: { grants: PermissionGrant[]; form: FormResult | null } = $props();

	type GrantTool = 'shell' | 'read' | 'write' | 'edit' | 'url';
	type ShellPositionalsKind = 'unset' | 'none' | 'any' | 'workspace-paths';
	type ShellPipelineKind = 'unset' | 'must' | 'forbid';
	type FsRuleKind = 'exact' | 'workspace' | 'workspace-glob' | 'prefix';
	type UrlRuleKind = 'exact' | 'host' | 'host-suffix';

	let newGrantTool = $state<GrantTool>('shell');
	let newGrantDecision = $state<'allow' | 'deny'>('allow');
	let newGrantExpiry = $state('');
	let newGrantDenyReason = $state('');
	let editingGrantId = $state<number | null>(null);
	let editingGrantMeta = $state<{
		conversationId: string | null;
		conversationTitle: string | null;
	} | null>(null);
	let detailsOpen = $state(false);

	let shellArgv0 = $state('');
	let shellSubcommands = $state('');
	let shellPositionals = $state<ShellPositionalsKind>('unset');
	let shellPipeline = $state<ShellPipelineKind>('unset');
	let shellFlagsDeny = $state('');
	let shellFlagsAllow = $state('');

	let fsRuleKind = $state<FsRuleKind>('workspace');
	let fsExactPath = $state('');
	let fsGlob = $state('');
	let fsPrefixPath = $state('');

	let urlRuleKind = $state<UrlRuleKind>('host');
	let urlExact = $state('');
	let urlHost = $state('');
	let urlSuffix = $state('');

	function csvToList(s: string): string[] {
		return s
			.split(',')
			.map((t) => t.trim())
			.filter((t) => t.length > 0);
	}

	type BuildResult = { json: string; error: null } | { json: null; error: string };

	function buildScopeJson(): BuildResult {
		try {
			if (newGrantTool === 'shell') {
				if (!shellArgv0.trim()) return { json: null, error: 'argv0 is required' };
				const rule: Record<string, unknown> = { argv0: shellArgv0.trim() };
				const subs = csvToList(shellSubcommands);
				if (subs.length > 0) rule.subcommands = subs;
				if (shellPositionals !== 'unset') rule.positionals = { kind: shellPositionals };
				if (shellPipeline !== 'unset') rule.pipeline = shellPipeline;
				const allow = csvToList(shellFlagsAllow);
				const deny = csvToList(shellFlagsDeny);
				if (allow.length > 0 || deny.length > 0) {
					const flags: Record<string, unknown> = {};
					if (allow.length > 0) flags.allow = allow;
					if (deny.length > 0) flags.deny = deny;
					rule.flags = flags;
				}
				return { json: JSON.stringify({ kind: 'shell', rule }), error: null };
			}
			if (newGrantTool === 'url') {
				let rule: Record<string, unknown>;
				switch (urlRuleKind) {
					case 'exact':
						if (!urlExact.trim()) return { json: null, error: 'URL is required' };
						rule = { kind: 'exact', url: urlExact.trim() };
						break;
					case 'host':
						if (!urlHost.trim()) return { json: null, error: 'host is required' };
						rule = { kind: 'host', host: urlHost.trim() };
						break;
					case 'host-suffix':
						if (!urlSuffix.trim()) return { json: null, error: 'suffix is required' };
						rule = { kind: 'host-suffix', suffix: urlSuffix.trim() };
						break;
				}
				return { json: JSON.stringify({ kind: 'url', rule }), error: null };
			}

			const perms = [newGrantTool] as ('read' | 'write' | 'edit')[];
			let rule: Record<string, unknown>;
			switch (fsRuleKind) {
				case 'exact':
					if (!fsExactPath.trim()) return { json: null, error: 'absolute path is required' };
					rule = { kind: 'exact', path: fsExactPath.trim() };
					break;
				case 'workspace':
					rule = { kind: 'workspace' };
					break;
				case 'workspace-glob':
					if (!fsGlob.trim()) return { json: null, error: 'glob is required' };
					rule = { kind: 'workspace-glob', glob: fsGlob.trim() };
					break;
				case 'prefix':
					if (!fsPrefixPath.trim()) return { json: null, error: 'absolute path is required' };
					rule = { kind: 'prefix', path: fsPrefixPath.trim() };
					break;
			}
			return { json: JSON.stringify({ kind: 'fs', perms, rule }), error: null };
		} catch (e) {
			return { json: null, error: e instanceof Error ? e.message : String(e) };
		}
	}

	const buildResult = $derived<BuildResult>(
		(() => {
			void newGrantTool;
			void shellArgv0;
			void shellSubcommands;
			void shellPositionals;
			void shellPipeline;
			void shellFlagsAllow;
			void shellFlagsDeny;
			void fsRuleKind;
			void fsExactPath;
			void fsGlob;
			void fsPrefixPath;
			void urlRuleKind;
			void urlExact;
			void urlHost;
			void urlSuffix;
			return buildScopeJson();
		})()
	);
	const scopeJsonPreview = $derived(buildResult.json ?? '');
	let userTouched = $state(false);
	const buildError = $derived(userTouched ? buildResult.error : null);

	function onSubmitCreateGrant(e: SubmitEvent) {
		const result = buildScopeJson();
		if (!result.json) {
			userTouched = true;
			e.preventDefault();
			return;
		}
		const formEl = e.currentTarget as HTMLFormElement;
		const hidden = formEl.elements.namedItem('scopeJson') as
			| HTMLInputElement
			| RadioNodeList
			| null;
		if (hidden && 'value' in hidden && !(hidden instanceof RadioNodeList)) {
			(hidden as HTMLInputElement).value = result.json;
		}
	}

	function resetGrantForm() {
		editingGrantId = null;
		editingGrantMeta = null;
		newGrantTool = 'shell';
		newGrantDecision = 'allow';
		newGrantExpiry = '';
		newGrantDenyReason = '';
		shellArgv0 = '';
		shellSubcommands = '';
		shellPositionals = 'unset';
		shellPipeline = 'unset';
		shellFlagsDeny = '';
		shellFlagsAllow = '';
		fsRuleKind = 'workspace';
		fsExactPath = '';
		fsGlob = '';
		fsPrefixPath = '';
		urlRuleKind = 'host';
		urlExact = '';
		urlHost = '';
		urlSuffix = '';
		userTouched = false;
	}

	function expiryToLocalInput(ms: number | null): string {
		if (ms == null) return '';
		const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
		return d.toISOString().slice(0, 16);
	}

	function startEditGrant(g: PermissionGrant) {
		resetGrantForm();
		editingGrantId = g.id;
		editingGrantMeta = {
			conversationId: g.conversationId,
			conversationTitle: g.conversationTitle
		};
		newGrantDecision = g.decision;
		newGrantExpiry = expiryToLocalInput(g.expiresAt);
		newGrantDenyReason = g.denyReason ?? '';

		if (
			g.tool === 'shell' ||
			g.tool === 'url' ||
			g.tool === 'read' ||
			g.tool === 'write' ||
			g.tool === 'edit'
		) {
			newGrantTool = g.tool;
		}

		const sc = g.scope;
		if (sc) {
			if (sc.kind === 'shell') {
				shellArgv0 = sc.rule.argv0;
				shellSubcommands = (sc.rule.subcommands ?? []).join(', ');
				shellPositionals = sc.rule.positionals?.kind ?? 'unset';
				shellPipeline = sc.rule.pipeline ?? 'unset';
				shellFlagsAllow = (sc.rule.flags?.allow ?? []).join(', ');
				shellFlagsDeny = (sc.rule.flags?.deny ?? []).join(', ');
			} else if (sc.kind === 'url') {
				urlRuleKind = sc.rule.kind;
				if (sc.rule.kind === 'exact') urlExact = sc.rule.url;
				else if (sc.rule.kind === 'host') urlHost = sc.rule.host;
				else urlSuffix = sc.rule.suffix;
			} else if (sc.kind === 'fs') {
				fsRuleKind = sc.rule.kind;
				if (sc.rule.kind === 'exact') fsExactPath = sc.rule.path;
				else if (sc.rule.kind === 'workspace-glob') fsGlob = sc.rule.glob;
				else if (sc.rule.kind === 'prefix') fsPrefixPath = sc.rule.path;
			}
		}

		detailsOpen = true;
		queueMicrotask(() => {
			document.querySelector('.add-grant')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		});
	}

	$effect(() => {
		if (
			form?.ok &&
			(form.formId === 'createGrant' || form.formId === 'updateGrant') &&
			!form.duplicate
		) {
			resetGrantForm();
		}
	});

	function canEditGrant(g: PermissionGrant): boolean {
		if (g.scope === null) return false;
		if (g.scope.kind === 'any') return false;
		if (!['shell', 'read', 'write', 'edit', 'url'].includes(g.tool)) return false;
		if (g.scope.kind === 'fs' && g.scope.perms && g.scope.perms.length > 1) return false;
		return true;
	}
</script>

<div
	id="settings-panel-permissions"
	class="tab-panel grants"
	role="tabpanel"
	aria-labelledby="settings-tab-permissions"
>
	<div class="section-heading">
		<h2>Saved permission grants</h2>
		<p class="muted small">Review persistent allow/deny rules separately from everyday settings.</p>
	</div>

	<details class="add-grant" bind:open={detailsOpen}>
		<summary>{editingGrantId !== null ? 'Edit permission grant' : 'Add a permission grant'}</summary
		>
		<form
			method="POST"
			action={editingGrantId !== null ? '?/updateGrant' : '?/createGrant'}
			class="add-grant-form"
			onsubmit={onSubmitCreateGrant}
		>
			{#if editingGrantId !== null}
				<p class="muted small">
					Editing grant #{editingGrantId}{editingGrantMeta?.conversationId
						? ` (scoped to ${editingGrantMeta.conversationTitle ?? editingGrantMeta.conversationId})`
						: ' (user-global)'}. The conversation scope and original grant time are preserved.
				</p>
				<input type="hidden" name="id" value={editingGrantId} />
			{:else}
				<p class="muted small">
					Author a user-global grant directly, without waiting for a tool prompt.
					Conversation-scoped grants are still created from the "Allow always" / "Deny always"
					buttons on the in-chat permission dialog.
				</p>
			{/if}

			<div class="grid">
				<label>
					Decision
					<select name="decision" bind:value={newGrantDecision}>
						<option value="allow">Allow</option>
						<option value="deny">Deny</option>
					</select>
				</label>
				<label>
					Tool
					<select name="tool" bind:value={newGrantTool}>
						<option value="shell">shell (run a command)</option>
						<option value="read">read (file read)</option>
						<option value="write">write (file write)</option>
						<option value="edit">edit (file edit)</option>
						<option value="url">url (fetch URL)</option>
					</select>
				</label>
				<label>
					Expires (optional)
					<input type="datetime-local" name="expiresAt" bind:value={newGrantExpiry} />
				</label>
			</div>

			{#if newGrantDecision === 'deny'}
				<label class="deny-reason">
					Deny reason / feedback (optional)
					<textarea
						name="denyReason"
						bind:value={newGrantDenyReason}
						rows="2"
						maxlength="500"
						placeholder="e.g. Prefer the structured `view` tool instead of `cat`."
					></textarea>
					<span class="muted small"
						>Surfaced to the agent as the SDK reject `feedback` string — explain *why* and what to
						do instead. Max 500 chars.</span
					>
				</label>
			{:else}
				<input type="hidden" name="denyReason" value="" />
			{/if}

			{#if newGrantTool === 'shell'}
				<fieldset class="scope-fields">
					<legend>Shell scope</legend>
					<label>
						argv0 (the bare command name)
						<input
							type="text"
							bind:value={shellArgv0}
							placeholder="cd"
							spellcheck="false"
							autocomplete="off"
						/>
						<span class="muted small">No slashes, no leading dot — just the program name.</span>
					</label>
					<label>
						Subcommands (optional, comma-separated)
						<input
							type="text"
							bind:value={shellSubcommands}
							placeholder="status, log, diff"
							spellcheck="false"
							autocomplete="off"
						/>
						<span class="muted small"
							>If set, argv[1] must be one of these (e.g. `git status` but not `git push`).</span
						>
					</label>
					<label>
						Positional arguments
						<select bind:value={shellPositionals}>
							<option value="unset">(unconstrained — any positionals)</option>
							<option value="none">none (the command takes no positional args)</option>
							<option value="any">any (positionals are anything)</option>
							<option value="workspace-paths"
								>workspace-paths (every positional must resolve inside the conversation's workspace)</option
							>
						</select>
					</label>
					<label>
						Pipeline constraint
						<select bind:value={shellPipeline}>
							<option value="unset">(no constraint — matches regardless of `|` neighbours)</option>
							<option value="must"
								>must — only matches when the command is part of a pipeline (`a | b`)</option
							>
							<option value="forbid">forbid — only matches when the command is NOT pipelined</option
							>
						</select>
						<span class="muted small"
							>Useful for deny grants that nudge toward structured alternatives: `pipeline=forbid`
							lets `cmd | grep ...` keep working while rejecting bare `grep`.</span
						>
					</label>
					<label>
						Flag deny list (optional, comma-separated)
						<input
							type="text"
							bind:value={shellFlagsDeny}
							placeholder="--git-dir, -C"
							spellcheck="false"
							autocomplete="off"
						/>
						<span class="muted small"
							>Reject if any argv token equals one of these (or starts with `flag=`). Each entry
							must start with `-`.</span
						>
					</label>
					<label>
						Flag allow list (optional, comma-separated)
						<input
							type="text"
							bind:value={shellFlagsAllow}
							placeholder="-n, --oneline"
							spellcheck="false"
							autocomplete="off"
						/>
						<span class="muted small"
							>If set, every flag-shaped token (starting with `-`) must be in this list. Positionals
							are governed by the row above.</span
						>
					</label>
				</fieldset>
			{:else if newGrantTool === 'url'}
				<fieldset class="scope-fields">
					<legend>URL scope</legend>
					<label>
						Match by
						<select bind:value={urlRuleKind}>
							<option value="exact">exact URL</option>
							<option value="host">exact host</option>
							<option value="host-suffix">host suffix (e.g. *.github.com)</option>
						</select>
					</label>
					{#if urlRuleKind === 'exact'}
						<label>
							URL
							<input
								type="url"
								bind:value={urlExact}
								placeholder="https://api.github.com/users/octocat"
								autocomplete="off"
							/>
						</label>
					{:else if urlRuleKind === 'host'}
						<label>
							Host
							<input
								type="text"
								bind:value={urlHost}
								placeholder="api.github.com"
								autocomplete="off"
							/>
						</label>
					{:else}
						<label>
							Suffix
							<input
								type="text"
								bind:value={urlSuffix}
								placeholder="github.com"
								autocomplete="off"
							/>
							<span class="muted small"
								>Matches hosts equal to `suffix` or ending with `.suffix` (so `github.com` and
								`api.github.com` both match `github.com`).</span
							>
						</label>
					{/if}
				</fieldset>
			{:else}
				<fieldset class="scope-fields">
					<legend>Filesystem scope ({newGrantTool})</legend>
					<label>
						Match by
						<select bind:value={fsRuleKind}>
							<option value="workspace">anywhere inside the workspace</option>
							<option value="workspace-glob"
								>workspace path matching a glob (e.g. src/**/*.ts)</option
							>
							<option value="exact">one exact absolute path</option>
							<option value="prefix"
								>absolute path or anything inside it (out-of-workspace directory)</option
							>
						</select>
					</label>
					{#if fsRuleKind === 'exact'}
						<label>
							Absolute path
							<input
								type="text"
								bind:value={fsExactPath}
								placeholder="/etc/hosts"
								spellcheck="false"
								autocomplete="off"
							/>
						</label>
					{:else if fsRuleKind === 'workspace-glob'}
						<label>
							Glob (relative to workspace root)
							<input
								type="text"
								bind:value={fsGlob}
								placeholder="src/**/*.ts"
								spellcheck="false"
								autocomplete="off"
							/>
							<span class="muted small"
								>`*` matches one path segment, `**` matches any number. The target must also be
								inside the workspace.</span
							>
						</label>
					{:else if fsRuleKind === 'prefix'}
						<label>
							Absolute directory
							<input
								type="text"
								bind:value={fsPrefixPath}
								placeholder="/home/me/.config/foo"
								spellcheck="false"
								autocomplete="off"
							/>
							<span class="muted small"
								>Matches `path` and anything resolving inside it (symlinks followed).</span
							>
						</label>
					{/if}
				</fieldset>
			{/if}

			<input type="hidden" name="scopeJson" value={scopeJsonPreview} />

			{#if scopeJsonPreview}
				<details class="scope-preview">
					<summary>Preview JSON</summary>
					<pre><code>{scopeJsonPreview}</code></pre>
				</details>
			{/if}
			{#if buildError}
				<div class="err small">{buildError}</div>
			{/if}
			{#if form?.formId === 'createGrant' && form.error}
				<div class="err small">{form.error}</div>
			{/if}
			{#if form?.formId === 'createGrant' && form.ok}
				<div class="ok small">
					{form.duplicate ? 'An identical grant already exists — no change.' : 'Grant created.'}
				</div>
			{/if}
			{#if form?.formId === 'updateGrant' && form.error}
				<div class="err small">{form.error}</div>
			{/if}
			{#if form?.formId === 'updateGrant' && form.ok}
				<div class="ok small">Grant updated.</div>
			{/if}

			<div class="form-actions">
				<button class="btn primary" type="submit" disabled={!scopeJsonPreview}>
					{editingGrantId !== null ? 'Save changes' : 'Add grant'}
				</button>
				{#if editingGrantId !== null}
					<button class="btn" type="button" onclick={resetGrantForm}>Cancel</button>
				{/if}
			</div>
		</form>
	</details>

	<div class="grant-bulk-actions">
		<form method="POST" action="?/restoreSeedGrants" class="restore-seeds">
			<button
				class="btn small"
				type="submit"
				title="Re-install any default seed grants that are missing from your account (idempotent — won't touch existing rules)"
			>
				Restore default seed grants
			</button>
		</form>
		{#if grants.length > 0}
			<form
				method="POST"
				action="?/revokeAllGrants"
				class="revoke-all"
				onsubmit={(e) => {
					if (
						!confirm(
							`Revoke all ${grants.length} saved permission grant${grants.length === 1 ? '' : 's'}? This cannot be undone.`
						)
					) {
						e.preventDefault();
					}
				}}
			>
				<button class="btn small danger" type="submit">Revoke all grants</button>
			</form>
		{/if}
	</div>

	{#if grants.length === 0}
		<p class="muted small">
			No saved grants. When you click "Allow always" or "Deny always" on a tool prompt, the
			resulting rule shows up here so you can revoke it later. The button above re-installs the
			built-in defaults (file/dir reads, git read-only, structured-tool nudge denies).
		</p>
	{:else}
		<p class="muted small">
			{grants.length} active grant{grants.length === 1 ? '' : 's'}. Expired grants are cleared
			automatically when you load this page.
		</p>
		<ul class="grant-list">
			{#each grants as g (g.id)}
				<li class="grant-row">
					<span class="decision-tag {g.decision}">{g.decision === 'allow' ? 'Allow' : 'Deny'}</span>
					<code class="tool">{g.tool}</code>
					<span class="kind">{g.permissionKind ?? 'any kind'}</span>
					<code class="pattern" title={describeGrantScope(g)}>
						{describeGrantScope(g)}
					</code>
					<span class="meta">
						{grantScopeLabel(g)} · granted {formatTime(g.grantedAt)} · expires {formatExpiry(
							g.expiresAt
						)}
					</span>
					{#if g.decision === 'deny' && g.denyReason}
						<span class="deny-reason-row muted small" title={g.denyReason}
							>↳ feedback: {g.denyReason}</span
						>
					{/if}
					<form method="POST" action="?/revokeGrant" class="revoke">
						<input type="hidden" name="id" value={g.id} />
						{#if canEditGrant(g)}
							<button
								class="btn small"
								type="button"
								onclick={() => startEditGrant(g)}
								title="Prefill the form above with this grant for editing">Edit</button
							>
						{/if}
						<button class="btn small" type="submit">Revoke</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}
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
	code {
		background: var(--code-bg);
		padding: 0 0.25rem;
		border-radius: var(--radius-sm);
	}
	.form-actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-top: 0.25rem;
	}
	.add-grant {
		margin-bottom: 1rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.5rem 0.75rem;
	}
	.add-grant > summary {
		cursor: pointer;
		font-weight: 600;
	}
	.add-grant-form {
		margin-top: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.add-grant-form .grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 0.75rem;
	}
	.scope-fields {
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.5rem 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.scope-fields legend {
		padding: 0 0.25rem;
		font-size: 0.85em;
		color: var(--muted, #888);
	}
	.scope-preview pre {
		background: var(--code-bg, #1118);
		padding: 0.5rem;
		border-radius: 4px;
		overflow-x: auto;
		font-size: 0.85em;
	}
	.err {
		color: var(--danger, #d33);
	}
	.ok {
		color: var(--success);
		margin-left: 0.5rem;
	}
	.small {
		font-size: 0.85em;
	}
	.grant-list {
		list-style: none;
		padding: 0;
		margin: 0.75rem 0 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.grant-row {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.5rem;
		padding: 0.4rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		font-size: 0.9em;
	}
	.decision-tag {
		font-size: 0.75em;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 0.1rem 0.4rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
	}
	.decision-tag.allow {
		color: var(--success);
		border-color: var(--success);
	}
	.decision-tag.deny {
		color: var(--danger);
		border-color: var(--danger);
	}
	.grant-row .tool {
		font-weight: 600;
	}
	.grant-row .kind {
		font-size: 0.8em;
		opacity: 0.75;
	}
	.grant-row .pattern {
		font-family: var(--font-mono, monospace);
		font-size: 0.85em;
		opacity: 0.85;
		max-width: 28ch;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.grant-row .meta {
		font-size: 0.8em;
		opacity: 0.75;
	}
	.grant-row .revoke {
		margin-left: auto;
	}
	.revoke-all {
		margin: 0;
	}
	.grant-bulk-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0.25rem 0 0.75rem;
	}
	.grant-bulk-actions > form {
		margin: 0;
	}
	.btn.small {
		padding: 0.2rem 0.55rem;
		font-size: 0.8em;
	}
</style>
