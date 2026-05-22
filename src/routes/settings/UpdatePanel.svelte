<script lang="ts">
	import { streamSse } from '$lib/client/sse';

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
			if (deployStatus !== 'restarting') {
				deployStatus = 'failed';
				appendLog(`\nstream error: ${e instanceof Error ? e.message : String(e)}\n`);
			}
		} finally {
			deployBusy = false;
		}
	}
</script>

<div
	id="settings-panel-update"
	class="tab-panel deploy"
	role="tabpanel"
	aria-labelledby="settings-tab-update"
>
	<div class="section-heading">
		<h2>Update</h2>
		<p class="muted small">Run maintenance actions for this portal instance.</p>
	</div>
	<p class="muted small">
		Runs <code>pnpm verify</code> (lint, type-check, unit tests, and e2e — which also rebuilds),
		then exits so the <code>pnpm serve</code> supervisor relaunches on the refreshed code. "Pull
		&amp; restart" also does <code>git pull</code> and <code>pnpm install</code> first.
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
	.status.restarting,
	.status.running {
		color: var(--accent);
	}
	.status.ok {
		color: var(--success);
	}
	.status.failed {
		color: var(--danger);
	}
	.small {
		font-size: 0.85em;
	}
	code {
		background: var(--code-bg);
		padding: 0 0.25rem;
		border-radius: var(--radius-sm);
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
</style>
