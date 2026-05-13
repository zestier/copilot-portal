import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeConversation } from '$lib/server/conversation-auth';
import { listDir, workspaceRoot } from '$lib/server/files';
import { status as gitStatus, isGitRepo, type StatusEntry } from '$lib/server/git';

export type AggregatedStatus =
	| 'untracked'
	| 'ignored'
	| 'modified'
	| 'added'
	| 'deleted'
	| 'renamed'
	| 'conflicted';

function aggregate(e: StatusEntry): AggregatedStatus | null {
	if (e.index === 'conflicted' || e.worktree === 'conflicted') return 'conflicted';
	if (e.index === 'untracked' || e.worktree === 'untracked') return 'untracked';
	if (e.index === 'ignored' || e.worktree === 'ignored') return 'ignored';
	if (e.index === 'renamed' || e.worktree === 'renamed') return 'renamed';
	if (e.index === 'added' || e.worktree === 'added') return 'added';
	if (e.index === 'deleted' || e.worktree === 'deleted') return 'deleted';
	if (e.index === 'modified' || e.worktree === 'modified') return 'modified';
	return null;
}

export const GET: RequestHandler = async ({ params, locals, url }) => {
	authorizeConversation(params.id, locals.userId);
	const workdir = workspaceRoot();
	const relPath = url.searchParams.get('path') ?? '';
	const includeHidden = url.searchParams.get('hidden') === '1';
	const includeIgnored = url.searchParams.get('ignored') === '1';

	const dir = listDir(workdir, relPath, { includeHidden });
	if (!dir.ok) throw error(dir.status ?? 400, dir.reason);

	let initialized = false;
	const statusByPath = new Map<string, AggregatedStatus>();
	const dirAgg = new Map<string, AggregatedStatus>();
	if (await isGitRepo(workdir)) {
		initialized = true;
		const entries = await gitStatus(workdir, { includeIgnored });
		for (const e of entries) {
			const agg = aggregate(e);
			if (!agg) continue;
			statusByPath.set(e.path, agg);
			const parts = e.path.split('/');
			for (let i = 1; i < parts.length; i++) {
				const ancestor = parts.slice(0, i).join('/');
				if (!dirAgg.has(ancestor)) dirAgg.set(ancestor, agg);
			}
		}
	}

	const entries = dir.entries
		.filter((e) => !(relPath === '' && e.name === '.git'))
		.map((e) => {
			const fileStatus = statusByPath.get(e.relPath) ?? null;
			const folderStatus = e.type === 'directory' ? (dirAgg.get(e.relPath) ?? null) : null;
			return {
				...e,
				status: fileStatus,
				containsChanges: folderStatus
			};
		});

	return json({
		path: relPath.replace(/^\/+/, ''),
		entries,
		git: { initialized }
	});
};
