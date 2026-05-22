<script lang="ts">
	import type { PageData } from './$types';
	import { streamSse } from '$lib/client/sse';
	let { data, form }: { data: PageData; form: FormResult | null } = $props();
	type FormResult = {
		ok?: boolean;
		error?: string;
		formId?: string;
		duplicate?: boolean;
	};
	const s = $derived(data.settings);
	const copilot = $derived(data.copilot);

	function formatContextWindow(tokens: number | undefined): string {
		if (!tokens || !Number.isFinite(tokens)) return 'context size unknown';
		if (tokens >= 1_000_000) {
			const m = tokens / 1_000_000;
			const str = m >= 10 ? m.toFixed(0) : m.toFixed(1).replace(/\.0$/, '');
			return `${str}M ctx`;
		}
		if (tokens >= 1_000) {
			return `${Math.round(tokens / 1_000)}K ctx`;
		}
		return `${tokens} ctx`;
	}

	type RedeployEvent =
		| { type: 'step'; label: string; cmd: string }
		| { type: 'log'; stream: 'stdout' | 'stderr'; text: string }
		| { type: 'step-done'; label: string; code: number }
		| { type: 'done'; ok: boolean; failedStep?: string; restarting?: boolean; message?: string };

	let deployBusy = $state(false);
	let deployLog = $state('');
	let deployStatus = $state<'idle' | 'running' | 'ok' | 'failed' | 'restarting'>('idle');
	let logEl = $state<HTMLPreElement | undefined>();

	function appendLog(text: string) {
		deployLog += text;
		// Auto-scroll to bottom after render.
		queueMicrotask(() => {
			if (logEl) logEl.scrollTop = logEl.scrollHeight;
		});
	}

	async function redeploy(opts: { pull: boolean }) {
		if (deployBusy) return;
		const msg = opts.pull
			? 'Pull, rebuild, and restart the server now?'
			: 'Rebuild and restart the server now (no git pull)?';
		if (!confirm(msg)) return;
		deployBusy = true;
		deployStatus = 'running';
		deployLog = '';
		try {
			for await (const ev of streamSse<RedeployEvent>('/api/admin/redeploy', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ pull: opts.pull })
			})) {
				switch (ev.type) {
					case 'step':
						appendLog(`\n$ ${ev.cmd}\n`);
						break;
					case 'log':
						appendLog(ev.text);
						break;
					case 'step-done':
						if (ev.code !== 0) appendLog(`[${ev.label}] exited with code ${ev.code}\n`);
						break;
					case 'done':
						if (ev.ok) {
							deployStatus = 'restarting';
							appendLog('\n✓ build ok — restarting...\n');
						} else {
							deployStatus = 'failed';
							appendLog(
								`\n✗ failed${ev.failedStep ? ` at: ${ev.failedStep}` : ''}${ev.message ? ` (${ev.message})` : ''}\n`
							);
						}
						break;
				}
			}
		} catch (e) {
			// On successful redeploy the server closes the socket mid-stream
			// as it exits; treat that as expected when we've already seen
			// `done: ok`. Otherwise surface it.
			if (deployStatus !== 'restarting') {
				deployStatus = 'failed';
				appendLog(`\nstream error: ${e instanceof Error ? e.message : String(e)}\n`);
			}
		} finally {
			deployBusy = false;
		}
	}

	function authLabel(a: typeof copilot.auth): string {
		if (!a.isAuthenticated) return 'Not signed in';
		const who = a.login ? `@${a.login}` : 'signed in';
		const via = a.authType ? ` via ${a.authType}` : '';
		return `${who}${via}`;
	}

	function formatTime(ms: number): string {
		try {
			return new Date(ms).toLocaleString();
		} catch {
			return String(ms);
		}
	}

	function decisionLabel(
		d: 'allow-once' | 'allow-always' | 'deny' | 'deny-always' | 'auto-allow' | 'auto-deny'
	): string {
		switch (d) {
			case 'allow-once':
				return 'Allow once';
			case 'allow-always':
				return 'Allow always';
			case 'deny':
				return 'Deny';
			case 'deny-always':
				return 'Deny always';
			case 'auto-allow':
				return 'Auto-allow';
			case 'auto-deny':
				return 'Auto-deny';
		}
	}

	function grantScopeLabel(g: { conversationId: string | null; conversationTitle: string | null }) {
		if (!g.conversationId) return 'Global';
		return g.conversationTitle ?? g.conversationId;
	}

	/**
	 * Pretty-print the row's effective scope: structured first, falling
	 * back to legacy pattern. Keeps the table honest — a `prefix` fs
	 * grant on `~/.config/foo` shouldn't render as `*`.
	 */
	function describeGrantScope(g: {
		scope: import('$lib/permissions/scope-types').GrantScope | null;
		scopePattern: string | null;
	}): string {
		const s = g.scope;
		if (s) {
			switch (s.kind) {
				case 'any':
					return '*';
				case 'shell':
					return `argv0=${s.rule.argv0}`;
				case 'url':
					switch (s.rule.kind) {
						case 'exact':
							return s.rule.url;
						case 'host':
							return `host=${s.rule.host}`;
						case 'host-suffix':
							return `*.${s.rule.suffix}`;
					}
					break;
				case 'fs': {
					const perms = s.perms && s.perms.length > 0 ? `[${s.perms.join('|')}] ` : '';
					switch (s.rule.kind) {
						case 'exact':
							return `${perms}${s.rule.path}`;
						case 'workspace':
							return `${perms}<workspace>`;
						case 'workspace-glob':
							return `${perms}<workspace>/${s.rule.glob}`;
						case 'prefix':
							return `${perms}${s.rule.path}/**`;
					}
				}
			}
		}
		return g.scopePattern ?? '*';
	}

	function formatExpiry(ms: number | null): string {
		if (ms == null) return 'Never';
		const delta = ms - Date.now();
		if (delta <= 0) return 'expired';
		const mins = Math.round(delta / 60_000);
		if (mins < 60) return `in ${mins}m`;
		const hours = Math.round(mins / 60);
		if (hours < 48) return `in ${hours}h`;
		return `in ${Math.round(hours / 24)}d`;
	}

	// --- Add-grant form state ---
	//
	// We build a structured GrantScope on the client and serialize it
	// into a hidden `scopeJson` field at submit time. The server
	// re-validates with the same zod schema, so any client-side
	// permissiveness is harmless.

	type GrantTool = 'shell' | 'read' | 'write' | 'edit' | 'url';
	type ShellPositionalsKind = 'unset' | 'none' | 'any' | 'workspace-paths';
	type ShellPipelineKind = 'unset' | 'must' | 'forbid';
	type FsRuleKind = 'exact' | 'workspace' | 'workspace-glob' | 'prefix';
	type UrlRuleKind = 'exact' | 'host' | 'host-suffix';

	let newGrantTool = $state<GrantTool>('shell');
	let newGrantDecision = $state<'allow' | 'deny'>('allow');
	let newGrantExpiry = $state(''); // datetime-local string; '' = never
	let newGrantDenyReason = $state(''); // only used when decision === 'deny'

	// When non-null, the form acts as an Edit for that grant rowid
	// (preserves conversation scope + granted_at server-side). Resets to
	// null after a successful submit or Cancel.
	let editingGrantId = $state<number | null>(null);
	let editingGrantMeta = $state<{
		conversationId: string | null;
		conversationTitle: string | null;
	} | null>(null);
	let detailsOpen = $state(false);

	// Shell
	let shellArgv0 = $state('');
	let shellSubcommands = $state(''); // comma-separated
	let shellPositionals = $state<ShellPositionalsKind>('unset');
	let shellPipeline = $state<ShellPipelineKind>('unset');
	let shellFlagsDeny = $state(''); // comma-separated
	let shellFlagsAllow = $state(''); // comma-separated

	// FS
	let fsRuleKind = $state<FsRuleKind>('workspace');
	let fsExactPath = $state('');
	let fsGlob = $state('');
	let fsPrefixPath = $state('');

	// URL
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
			// fs: read / write / edit
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

	// Pure $derived: no $state mutations inside, so Svelte 5 is happy.
	// Reads of the field $states establish reactivity automatically.
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
	// Only show the build error after the user has interacted at least
	// once — otherwise the form renders with "argv0 is required" on first
	// paint, which is noisy. Flipped on first failed submit.
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
		// <input type="datetime-local"> wants `YYYY-MM-DDTHH:mm` in *local*
		// time, no timezone suffix. Subtract the offset before slicing the
		// ISO string so the prefilled value matches what the user picked.
		const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
		return d.toISOString().slice(0, 16);
	}

	function startEditGrant(g: (typeof data.grants)[number]) {
		resetGrantForm();
		editingGrantId = g.id;
		editingGrantMeta = {
			conversationId: g.conversationId,
			conversationTitle: g.conversationTitle
		};
		newGrantDecision = g.decision;
		newGrantExpiry = expiryToLocalInput(g.expiresAt);
		newGrantDenyReason = g.denyReason ?? '';

		// Map stored tool back to the form's tool select. For fs grants
		// the row's `tool` is already one of read/write/edit; shell/url
		// map 1:1.
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
		// Scroll the form into view on the next tick so the user sees
		// where their click went.
		queueMicrotask(() => {
			document.querySelector('.add-grant')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		});
	}

	// Auto-close the form after a successful create/update, and clear
	// edit state so the next open is a fresh "Add grant".
	$effect(() => {
		if (
			form?.ok &&
			(form.formId === 'createGrant' || form.formId === 'updateGrant') &&
			!form.duplicate
		) {
			resetGrantForm();
		}
	});

	function canEditGrant(g: (typeof data.grants)[number]): boolean {
		// Need a structured scope to round-trip into the form. Legacy
		// `scope === null` rows and the `{kind:'any'}` catch-all aren't
		// editable here — revoke + recreate is the workaround.
		if (g.scope === null) return false;
		if (g.scope.kind === 'any') return false;
		// Tool must be one the form can author.
		if (!['shell', 'read', 'write', 'edit', 'url'].includes(g.tool)) return false;
		// The form authors single-perm fs scopes (perms: [tool]). Editing
		// a multi-perm grant here would silently narrow it; force users to
		// revoke + recreate so the loss is explicit.
		if (g.scope.kind === 'fs' && g.scope.perms && g.scope.perms.length > 1) return false;
		return true;
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
						<option value={m.id}
							>{m.name} — {m.id} ({formatContextWindow(m.maxContextWindowTokens)})</option
						>
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
				placeholder="(blank = PROJECT_ROOT)"
			/>
		</label>
		<label>
			Permission policy
			<select name="defaultPolicy" value={s.defaultPolicy}>
				<option value="prompt"
					>Auto-allow file ops inside the workspace, prompt otherwise (default)</option
				>
				<option value="allow-all">Allow all (dangerous)</option>
				<option value="deny-all">Deny all</option>
			</select>
		</label>
		<label>
			Theme
			<select name="theme" value={s.theme}>
				<option value="system">System</option>
				<option value="dark">Dark</option>
				<option value="light">Light</option>
			</select>
		</label>

		<div class="form-actions">
			<button class="btn primary" type="submit">Save</button>
			{#if form?.ok}<span class="ok">Saved.</span>{/if}
		</div>
	</form>

	<form method="POST" action="/logout" class="logout-form">
		<button class="btn">Log out</button>
	</form>

	<section class="grants">
		<h2>Saved permission grants</h2>

		<details class="add-grant" bind:open={detailsOpen}>
			<summary
				>{editingGrantId !== null ? 'Edit permission grant' : 'Add a permission grant'}</summary
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
									>workspace-paths (every positional must resolve inside the conversation's
									workspace)</option
								>
							</select>
						</label>
						<label>
							Pipeline constraint
							<select bind:value={shellPipeline}>
								<option value="unset">(no constraint — matches regardless of `|` neighbours)</option
								>
								<option value="must"
									>must — only matches when the command is part of a pipeline (`a | b`)</option
								>
								<option value="forbid"
									>forbid — only matches when the command is NOT pipelined</option
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
								>If set, every flag-shaped token (starting with `-`) must be in this list.
								Positionals are governed by the row above.</span
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
			{#if data.grants.length > 0}
				<form
					method="POST"
					action="?/revokeAllGrants"
					class="revoke-all"
					onsubmit={(e) => {
						if (
							!confirm(
								`Revoke all ${data.grants.length} saved permission grant${data.grants.length === 1 ? '' : 's'}? This cannot be undone.`
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

		{#if data.grants.length === 0}
			<p class="muted small">
				No saved grants. When you click "Allow always" or "Deny always" on a tool prompt, the
				resulting rule shows up here so you can revoke it later. The button above re-installs the
				built-in defaults (file/dir reads, git read-only, structured-tool nudge denies).
			</p>
		{:else}
			<p class="muted small">
				{data.grants.length} active grant{data.grants.length === 1 ? '' : 's'}. Expired grants are
				cleared automatically when you load this page.
			</p>
			<ul class="grant-list">
				{#each data.grants as g (g.id)}
					<li class="grant-row">
						<span class="decision-tag {g.decision}"
							>{g.decision === 'allow' ? 'Allow' : 'Deny'}</span
						>
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
	</section>

	<section class="decisions">
		<h2>Recent permission decisions</h2>
		{#if data.recentDecisions.length === 0}
			<p class="muted small">No permission requests have been answered yet.</p>
		{:else}
			<p class="muted small">
				The last {data.recentDecisions.length} tool permission decisions across your conversations. "Allow
				always" rows also installed a grant for that tool in the listed conversation.
			</p>
			<ul class="decision-list">
				{#each data.recentDecisions as d (d.id)}
					<li class="decision-row">
						<span class="decision-tag {d.decision}">{decisionLabel(d.decision)}</span>
						<code class="tool">{d.tool}</code>
						{#if d.argsSummary}<span class="args" title={d.argsSummary}>{d.argsSummary}</span>{/if}
						<span class="meta">
							in
							<a href="/conversations/{d.conversationId}"
								>{d.conversationTitle ?? d.conversationId}</a
							>
							· {formatTime(d.decidedAt)}
						</span>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	{#if data.enableRedeploy}
		<section class="deploy">
			<h2>Update</h2>
			<p class="muted small">
				Runs <code>pnpm run verify</code> (lint, type-check, unit tests, and e2e — which also
				rebuilds), then exits so the <code>pnpm run serve</code> supervisor relaunches on the
				refreshed code. "Pull &amp; restart" also does <code>git pull</code> and
				<code>pnpm install</code> first.
			</p>
			<div class="deploy-buttons">
				<button class="btn" onclick={() => redeploy({ pull: true })} disabled={deployBusy}>
					{deployBusy ? 'Working…' : 'Pull & restart'}
				</button>
				<button class="btn" onclick={() => redeploy({ pull: false })} disabled={deployBusy}>
					Rebuild & restart
				</button>
				{#if deployStatus !== 'idle'}
					<span class="status {deployStatus}">{deployStatus}</span>
				{/if}
			</div>
			{#if deployLog}
				<pre bind:this={logEl} class="log">{deployLog}</pre>
			{/if}
		</section>
	{/if}
</div>

<style>
	.wrap {
		width: 100%;
		max-width: 640px;
		min-width: 0;
		margin: 0 auto;
		padding: 2.5rem 1.5rem 3rem;
		height: 100%;
		overflow-y: auto;
	}
	h1 {
		margin: 0 0 1.5rem;
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
	.logout-form {
		display: block;
		margin-bottom: 0;
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
	.deploy {
		margin-top: 2rem;
		padding-top: 1.5rem;
		border-top: 1px solid var(--border);
	}
	.deploy h2 {
		margin: 0 0 0.5rem;
		font-size: 1.05rem;
	}
	.deploy p {
		margin: 0 0 0.75rem;
	}
	.deploy-buttons {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		flex-wrap: wrap;
	}
	.status {
		margin-left: 0.75rem;
		font-size: 0.85em;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.status.restarting {
		color: var(--accent);
	}
	.status.running {
		color: var(--accent);
	}
	.status.ok {
		color: var(--success);
	}
	.status.failed {
		color: var(--danger);
	}
	pre.log {
		margin-top: 0.75rem;
		max-height: 360px;
		overflow: auto;
		padding: 0.75rem;
		background: var(--code-bg);
		border: 1px solid var(--code-border);
		border-radius: var(--radius-sm);
		font-size: var(--code-fs);
		white-space: pre-wrap;
		word-break: break-word;
	}
	.decisions {
		margin-top: 2rem;
		padding-top: 1.5rem;
		border-top: 1px solid var(--border);
	}
	.decisions h2 {
		margin: 0 0 0.5rem;
		font-size: 1.05rem;
	}
	.decision-list {
		list-style: none;
		padding: 0;
		margin: 0.75rem 0 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.decision-row {
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
	.decision-tag.allow-once {
		color: var(--success);
		border-color: var(--success);
	}
	.decision-tag.allow-always {
		color: var(--success);
		border-color: var(--success);
		background: var(--success-bg, transparent);
	}
	.decision-tag.deny,
	.decision-tag.deny-always {
		color: var(--danger);
		border-color: var(--danger);
	}
	.decision-tag.auto-allow {
		color: var(--muted, var(--success));
		border-color: var(--border);
		font-style: italic;
	}
	.decision-tag.auto-deny {
		color: var(--muted, var(--danger));
		border-color: var(--border);
		font-style: italic;
	}
	.decision-row .tool {
		font-weight: 600;
	}
	.decision-row .args {
		font-family: var(--font-mono, monospace);
		font-size: 0.85em;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		opacity: 0.85;
	}
	.decision-row .meta {
		margin-left: auto;
		font-size: 0.8em;
		opacity: 0.75;
	}
	.grants {
		margin-top: 2rem;
		padding-top: 1.5rem;
		border-top: 1px solid var(--border);
	}
	.grants h2 {
		margin: 0 0 0.5rem;
		font-size: 1.05rem;
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
