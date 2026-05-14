<script lang="ts">
	import { untrack } from 'svelte';
	import FileTree from './FileTree.svelte';
	import CommitList from './CommitList.svelte';
	import ChangeList from './ChangeList.svelte';
	import DiffView from './DiffView.svelte';
	import GitStatusHeader from './GitStatusHeader.svelte';
	import type {
		FsEntry,
		FileResponse,
		CommitDetail,
		ChangeEntry,
		ChangeStatus
	} from '$lib/client/file-browser';
	import { STATUS_LABEL, STATUS_COLOR } from '$lib/client/file-browser';

	let { conversationId }: { conversationId: string } = $props();

	type ViewMode = 'content' | 'diff';
	type Pane = 'changes' | 'files' | 'commits';

	let pane = $state<Pane>('changes');
	let viewMode = $state<ViewMode>('content');
	let selectedPath = $state<string | null>(null);
	let selectedStatus = $state<ChangeStatus | null>(null);
	let fileData = $state<FileResponse | null>(null);
	let fileLoading = $state(false);
	let fileError = $state<string | null>(null);

	let diffText = $state<string>('');
	let diffLoading = $state(false);
	let diffError = $state<string | null>(null);

	let selectedSha = $state<string | null>(null);
	let commitDetail = $state<CommitDetail | null>(null);
	let commitDetailError = $state<string | null>(null);
	let commitFilePath = $state<string | null>(null);
	let commitFileDiff = $state<string>('');

	let showHidden = $state(false);
	let showIgnored = $state(false);
	let gitRefreshToken = $state(0);

	function bumpGitRefresh() {
		gitRefreshToken++;
	}

	async function loadFile(path: string) {
		fileLoading = true;
		fileError = null;
		fileData = null;
		try {
			const params = new URLSearchParams({ path });
			const res = await fetch(`/api/conversations/${conversationId}/fs/file?${params}`);
			if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
			fileData = await res.json();
		} catch (e) {
			fileError = e instanceof Error ? e.message : String(e);
		} finally {
			fileLoading = false;
		}
	}

	async function loadDiff(path: string) {
		diffLoading = true;
		diffError = null;
		diffText = '';
		try {
			const params = new URLSearchParams({ target: 'worktree-vs-head', path });
			const res = await fetch(`/api/conversations/${conversationId}/fs/diff?${params}`);
			if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
			const data = (await res.json()) as { diff: string };
			diffText = data.diff;
		} catch (e) {
			diffError = e instanceof Error ? e.message : String(e);
		} finally {
			diffLoading = false;
		}
	}

	function pickFile(entry: FsEntry) {
		if (entry.type !== 'file' && entry.type !== 'symlink') return;
		selectedPath = entry.relPath;
		selectedStatus = entry.status;
		// If file has changes, prefer the diff view; else content.
		viewMode =
			entry.status && entry.status !== 'untracked' && entry.status !== 'ignored'
				? 'diff'
				: 'content';
		loadFile(entry.relPath);
		if (viewMode === 'diff') loadDiff(entry.relPath);
	}

	function pickChange(entry: ChangeEntry) {
		selectedPath = entry.path;
		selectedStatus = entry.status;
		diffText = '';
		diffError = null;
		viewMode = entry.status === 'untracked' ? 'content' : 'diff';
		loadFile(entry.path);
		if (viewMode === 'diff') loadDiff(entry.path);
	}

	$effect(() => {
		if (!selectedPath) return;
		if (viewMode === 'diff') {
			untrack(() => {
				if (diffText === '' && !diffLoading && !diffError && selectedPath) {
					loadDiff(selectedPath);
				}
			});
		}
	});

	async function loadCommit(sha: string) {
		selectedSha = sha;
		commitDetail = null;
		commitDetailError = null;
		commitFilePath = null;
		commitFileDiff = '';
		try {
			const res = await fetch(`/api/conversations/${conversationId}/git/commit/${sha}`);
			if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
			commitDetail = await res.json();
		} catch (e) {
			commitDetailError = e instanceof Error ? e.message : String(e);
		}
	}

	async function loadCommitFileDiff(path: string) {
		if (!selectedSha) return;
		commitFilePath = path;
		commitFileDiff = '';
		try {
			const params = new URLSearchParams({
				target: 'commit-vs-parent',
				sha: selectedSha,
				path
			});
			const res = await fetch(`/api/conversations/${conversationId}/fs/diff?${params}`);
			if (!res.ok) throw new Error(await res.text());
			const data = (await res.json()) as { diff: string };
			commitFileDiff = data.diff;
		} catch (e) {
			commitFileDiff = `Failed to load diff: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	function fmtSize(n: number | null | undefined): string {
		if (n == null) return '';
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
	}
</script>

<div class="browser">
	<div class="left">
		<GitStatusHeader {conversationId} refreshToken={gitRefreshToken} />
		<div class="pane-tabs" role="tablist">
			<button
				role="tab"
				aria-selected={pane === 'changes'}
				class:active={pane === 'changes'}
				onclick={() => (pane = 'changes')}
			>
				Changes
			</button>
			<button
				role="tab"
				aria-selected={pane === 'files'}
				class:active={pane === 'files'}
				onclick={() => (pane = 'files')}
			>
				All files
			</button>
			<button
				role="tab"
				aria-selected={pane === 'commits'}
				class:active={pane === 'commits'}
				onclick={() => (pane = 'commits')}
			>
				Commits
			</button>
		</div>
		{#if pane === 'files'}
			<div class="filter-toggles">
				<label><input type="checkbox" bind:checked={showHidden} /> Hidden</label>
				<label><input type="checkbox" bind:checked={showIgnored} /> Ignored</label>
			</div>
			<div class="pane-body">
				<FileTree
					{conversationId}
					{selectedPath}
					{showHidden}
					{showIgnored}
					onselect={pickFile}
					onrefresh={bumpGitRefresh}
				/>
			</div>
		{:else if pane === 'changes'}
			<div class="pane-body">
				<ChangeList
					{conversationId}
					{selectedPath}
					refreshToken={gitRefreshToken}
					onselect={pickChange}
					onrefresh={bumpGitRefresh}
				/>
			</div>
		{:else}
			<div class="pane-body">
				<CommitList {conversationId} {selectedSha} onselect={loadCommit} />
			</div>
		{/if}
	</div>

	<div class="right">
		{#if pane === 'commits' && selectedSha}
			<div class="header">
				<div class="title">
					<code class="sha">{commitDetail?.shortSha ?? selectedSha.slice(0, 8)}</code>
					<span>{commitDetail?.subject ?? 'Loading…'}</span>
				</div>
				{#if commitDetail}
					<div class="muted small">
						{commitDetail.author} · {new Date(commitDetail.timestamp).toLocaleString()}
					</div>
				{/if}
			</div>
			<div class="commit-body">
				{#if commitDetailError}
					<div class="error">{commitDetailError}</div>
				{:else if commitDetail}
					{#if commitDetail.body}
						<pre class="commit-message">{commitDetail.body}</pre>
					{/if}
					<div class="files-grid">
						<div class="commit-files">
							{#each commitDetail.files as f (f.path)}
								<button
									class="commit-file"
									class:selected={commitFilePath === f.path}
									onclick={() => loadCommitFileDiff(f.path)}
								>
									<span class="status-pill" style:color={STATUS_COLOR[f.status]}
										>{STATUS_LABEL[f.status]}</span
									>
									<span class="path">{f.path}</span>
								</button>
							{/each}
						</div>
						<div class="commit-diff">
							{#if commitFilePath}
								<DiffView path={commitFilePath} diff={commitFileDiff || 'Loading…'} />
							{:else}
								<div class="placeholder">Select a file to see its diff.</div>
							{/if}
						</div>
					</div>
				{:else}
					<div class="placeholder">Loading commit…</div>
				{/if}
			</div>
		{:else if selectedPath}
			<div class="header">
				<div class="title">
					<code class="path">{selectedPath}</code>
					{#if selectedStatus}
						<span class="status-pill" style:color={STATUS_COLOR[selectedStatus]}>
							{STATUS_LABEL[selectedStatus]}
						</span>
					{/if}
				</div>
				<div class="view-tabs" role="tablist">
					<button
						role="tab"
						aria-selected={viewMode === 'content'}
						class:active={viewMode === 'content'}
						onclick={() => (viewMode = 'content')}
					>
						Content
					</button>
					<button
						role="tab"
						aria-selected={viewMode === 'diff'}
						class:active={viewMode === 'diff'}
						onclick={() => {
							viewMode = 'diff';
							if (selectedPath && diffText === '') loadDiff(selectedPath);
						}}
						disabled={!selectedStatus ||
							selectedStatus === 'untracked' ||
							selectedStatus === 'ignored'}
						title={!selectedStatus
							? 'File is unchanged'
							: selectedStatus === 'untracked'
								? 'File is untracked'
								: ''}
					>
						Diff
					</button>
				</div>
			</div>
			<div class="content-body">
				{#if viewMode === 'content'}
					{#if fileLoading}
						<div class="placeholder">Loading…</div>
					{:else if fileError}
						<div class="error">{fileError}</div>
					{:else if fileData?.binary}
						<div class="placeholder">
							Binary file ({fmtSize((fileData as { size?: number }).size ?? null)}).
						</div>
					{:else if fileData}
						<pre class="file-view">{fileData.content}</pre>
						{#if fileData.truncated}
							<div class="muted small truncated-note">
								File truncated at 1 MiB (real size: {fmtSize(fileData.size)}).
							</div>
						{/if}
					{/if}
				{:else if diffLoading}
					<div class="placeholder">Loading diff…</div>
				{:else if diffError}
					<div class="error">{diffError}</div>
				{:else if diffText}
					<DiffView path={selectedPath} diff={diffText} />
				{:else}
					<div class="placeholder">No changes for this file.</div>
				{/if}
			</div>
		{:else}
			<div class="placeholder">Select a file or commit to view it.</div>
		{/if}
	</div>
</div>

<style>
	.browser {
		display: grid;
		grid-template-columns: minmax(220px, 320px) 1fr;
		height: 100%;
		min-height: 0;
		gap: 0;
	}
	.left {
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-right: 1px solid var(--border);
		background: var(--surface);
	}
	.right {
		display: flex;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
	}
	.pane-tabs,
	.view-tabs {
		display: flex;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
	}
	.pane-tabs button,
	.view-tabs button {
		flex: 1;
		background: transparent;
		color: var(--text-muted);
		border: 0;
		border-bottom: 2px solid transparent;
		padding: var(--space-2) var(--space-3);
		cursor: pointer;
		font: inherit;
	}
	.view-tabs button {
		flex: 0 0 auto;
	}
	.pane-tabs button.active,
	.view-tabs button.active {
		color: var(--text);
		border-bottom-color: var(--accent);
	}
	.pane-tabs button:disabled,
	.view-tabs button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.filter-toggles {
		display: flex;
		gap: var(--space-3);
		padding: 0.35rem var(--space-3);
		font-size: var(--fs-sm);
		border-bottom: 1px solid var(--border);
		color: var(--text-muted);
	}
	.filter-toggles label {
		display: inline-flex;
		gap: var(--space-1);
		align-items: center;
		cursor: pointer;
	}
	.pane-body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.header {
		padding: var(--space-2) var(--space-3);
		border-bottom: 1px solid var(--border);
		background: var(--surface);
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.title {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.title .path,
	.title .sha {
		font-family: var(--mono);
		font-size: var(--fs-md);
	}
	.view-tabs {
		margin-top: var(--space-1);
	}
	.content-body,
	.commit-body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.content-body {
		padding: var(--space-3);
		gap: var(--space-2);
	}
	.commit-message {
		margin: 0;
		padding: var(--space-3);
		background: var(--surface-2);
		border-bottom: 1px solid var(--border);
		font-family: var(--mono);
		font-size: var(--fs-sm);
		white-space: pre-wrap;
	}
	.files-grid {
		display: grid;
		grid-template-columns: minmax(220px, 320px) 1fr;
		flex: 1;
		min-height: 0;
		gap: 0;
		border-top: 1px solid var(--border);
	}
	.commit-files {
		overflow: auto;
		border-right: 1px solid var(--border);
		background: var(--surface);
		min-height: 0;
	}
	.commit-file {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: 100%;
		text-align: left;
		background: transparent;
		color: var(--text);
		border: 0;
		padding: var(--space-1) var(--space-3);
		font: inherit;
		cursor: pointer;
	}
	.commit-file:hover {
		background: var(--surface-hover);
	}
	.commit-file.selected {
		background: var(--surface-2);
		outline: 1px solid var(--accent);
		outline-offset: -1px;
	}
	.commit-file .path {
		font-family: var(--mono);
		font-size: var(--fs-sm);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.commit-diff {
		overflow: auto;
		min-height: 0;
		padding: var(--space-2);
	}
	.file-view {
		margin: 0;
		flex: 1;
		min-height: 0;
		font-family: var(--mono);
		font-size: var(--code-fs);
		white-space: pre;
		overflow: auto;
		background: var(--bg);
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
	}
	.placeholder {
		color: var(--text-muted);
		font-style: italic;
		padding: var(--space-4);
	}
	.error {
		color: var(--danger);
		padding: var(--space-2) var(--space-3);
	}
	.muted {
		color: var(--text-muted);
	}
	.small {
		font-size: var(--fs-sm);
	}
	.truncated-note {
		margin-top: 0.3rem;
	}
	.status-pill {
		font-family: var(--mono);
		font-weight: 600;
	}

	@media (max-width: 768px) {
		.browser {
			grid-template-columns: 1fr;
			grid-template-rows: minmax(180px, 40%) 1fr;
		}
		.left {
			border-right: 0;
			border-bottom: 1px solid var(--border);
		}
		.files-grid {
			grid-template-columns: 1fr;
			grid-template-rows: minmax(120px, 35%) 1fr;
		}
		.commit-files {
			border-right: 0;
			border-bottom: 1px solid var(--border);
		}
	}
</style>
