<script lang="ts">
	import type { PageData } from './$types';
	import { streamSse } from '$lib/client/sse';
	let { data, form }: { data: PageData; form: { ok?: boolean } | null } = $props();
	const s = $derived(data.settings);
	const copilot = $derived(data.copilot);

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

	function decisionLabel(d: 'allow-once' | 'allow-always' | 'deny' | 'deny-always'): string {
		switch (d) {
			case 'allow-once':
				return 'Allow once';
			case 'allow-always':
				return 'Allow always';
			case 'deny':
				return 'Deny';
			case 'deny-always':
				return 'Deny always';
		}
	}

	function grantScopeLabel(g: { conversationId: string | null; conversationTitle: string | null }) {
		if (!g.conversationId) return 'Global';
		return g.conversationTitle ?? g.conversationId;
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
				placeholder="(blank = PROJECT_ROOT)"
			/>
		</label>
		<label>
			Permission policy
			<select name="defaultPolicy" value={s.defaultPolicy}>
				<option value="prompt">Auto-allow read-only tools, prompt otherwise (default)</option>
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
		{#if data.grants.length === 0}
			<p class="muted small">
				No saved grants. When you click "Allow always" or "Deny always" on a tool prompt, the
				resulting rule shows up here so you can revoke it later.
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
						<code class="pattern" title={g.scopePattern ?? 'any scope'}>
							{g.scopePattern ?? '*'}
						</code>
						<span class="meta">
							{grantScopeLabel(g)} · granted {formatTime(g.grantedAt)} · expires {formatExpiry(
								g.expiresAt
							)}
						</span>
						<form method="POST" action="?/revokeGrant" class="revoke">
							<input type="hidden" name="id" value={g.id} />
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
	.btn.small {
		padding: 0.2rem 0.55rem;
		font-size: 0.8em;
	}
</style>
