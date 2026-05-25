<script lang="ts">
	import DiffView from '../DiffView.svelte';
	import type { GitRenderedResult } from '$lib/client/git-tool-result';

	let { result }: { result: GitRenderedResult } = $props();

	function formatDate(ms: number): string {
		return new Date(ms).toLocaleString();
	}

	function count(n: number | null): string {
		return n === null ? 'binary' : String(n);
	}
</script>

{#if result.kind === 'diff-stat'}
	<div class="git-result">
		{#if result.total}
			<div class="summary">
				<span>{result.total.filesChanged} files</span>
				<span class="added">+{result.total.added}</span>
				<span class="removed">-{result.total.removed}</span>
			</div>
		{/if}
		<table>
			<thead>
				<tr><th>File</th><th>Added</th><th>Removed</th></tr>
			</thead>
			<tbody>
				{#each result.files as file}
					<tr>
						<td>
							<code>{file.path}</code>
							{#if file.origPath}<span class="muted"> from {file.origPath}</span>{/if}
						</td>
						<td class="num added">{count(file.added)}</td>
						<td class="num removed">{count(file.removed)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{:else if result.kind === 'diff-name-only'}
	<div class="git-result">
		<ul class="paths">
			{#each result.files as file}
				<li><code>{file}</code></li>
			{/each}
		</ul>
	</div>
{:else if result.kind === 'diff-name-status'}
	<div class="git-result">
		<table>
			<thead>
				<tr><th>Status</th><th>File</th></tr>
			</thead>
			<tbody>
				{#each result.files as file}
					<tr>
						<td><span class="status">{file.statusCode}</span></td>
						<td>
							<code>{file.path}</code>
							{#if file.origPath}<span class="muted"> from {file.origPath}</span>{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{:else if result.kind === 'log'}
	<div class="git-result">
		<table>
			<thead>
				<tr><th>Commit</th><th>Subject</th><th>Author</th><th>Date</th></tr>
			</thead>
			<tbody>
				{#each result.commits as commit}
					<tr>
						<td><code title={commit.sha}>{commit.shortSha}</code></td>
						<td>{commit.subject}</td>
						<td>{commit.author}</td>
						<td class="muted">{formatDate(commit.timestamp)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{:else if result.kind === 'commit'}
	<div class="git-result">
		<div class="commit-card">
			<div><code>{result.commit.shortSha}</code> {result.commit.subject}</div>
			<div class="muted">
				{result.commit.author} · {formatDate(result.commit.timestamp)}
			</div>
			{#if result.commit.body}<pre class="body">{result.commit.body}</pre>{/if}
		</div>
		<table>
			<thead>
				<tr><th>Status</th><th>File</th></tr>
			</thead>
			<tbody>
				{#each result.commit.files as file}
					<tr>
						<td><span class="status">{file.statusCode}</span></td>
						<td>
							<code>{file.path}</code>
							{#if file.origPath}<span class="muted"> from {file.origPath}</span>{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if result.commit.patch}
			<DiffView diff={result.commit.patch} collapsible />
		{/if}
	</div>
{/if}

<style>
	.git-result {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		font-size: var(--fs-sm);
	}
	.summary,
	.commit-card {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: baseline;
	}
	table {
		width: 100%;
		border-collapse: collapse;
	}
	th,
	td {
		padding: 0.25rem 0.4rem;
		border-bottom: 1px solid var(--border);
		text-align: left;
		vertical-align: top;
	}
	th {
		color: var(--text-muted);
		font-size: var(--fs-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.num {
		width: 5rem;
		text-align: right;
		font-family: var(--mono);
	}
	.added {
		color: var(--success, #3fb950);
	}
	.removed {
		color: var(--danger, #ff6b6b);
	}
	.status {
		font-family: var(--mono);
		font-weight: 600;
	}
	.muted {
		color: var(--text-muted);
	}
	.paths {
		margin: 0;
		padding-left: 1.2rem;
	}
	.body {
		width: 100%;
		margin: 0.2rem 0 0;
		white-space: pre-wrap;
		color: var(--text-muted);
	}
</style>
