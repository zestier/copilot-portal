import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeConversation } from '$lib/server/conversation-auth';
import { workspaceRoot } from '$lib/server/files';
import { status as gitStatus, isGitRepo, numstat, type StatusEntry } from '$lib/server/git';

export type ChangeStatus =
	| 'untracked'
	| 'modified'
	| 'added'
	| 'deleted'
	| 'renamed'
	| 'conflicted';

export interface ChangeEntry {
	path: string;
	origPath: string | null;
	status: ChangeStatus;
	staged: boolean;
	unstaged: boolean;
	added: number | null;
	removed: number | null;
}

function aggregate(e: StatusEntry): ChangeStatus | null {
	if (e.index === 'conflicted' || e.worktree === 'conflicted') return 'conflicted';
	if (e.index === 'untracked' || e.worktree === 'untracked') return 'untracked';
	if (e.index === 'renamed' || e.worktree === 'renamed') return 'renamed';
	if (e.index === 'added' || e.worktree === 'added') return 'added';
	if (e.index === 'deleted' || e.worktree === 'deleted') return 'deleted';
	if (e.index === 'modified' || e.worktree === 'modified') return 'modified';
	return null;
}

export const GET: RequestHandler = async ({ params, locals }) => {
	authorizeConversation(params.id, locals.userId);
	const workdir = workspaceRoot();
	if (!(await isGitRepo(workdir))) {
		return json({ initialized: false, entries: [] as ChangeEntry[] });
	}
	const raw = await gitStatus(workdir, { includeIgnored: false });
	const statsByPath = new Map<string, { added: number | null; removed: number | null }>();
	try {
		const ns = await numstat(workdir, { kind: 'worktree-vs-head' });
		for (const s of ns) statsByPath.set(s.path, { added: s.added, removed: s.removed });
	} catch {
		// Empty repo / no HEAD: skip line stats.
	}
	const entries: ChangeEntry[] = [];
	for (const e of raw) {
		const agg = aggregate(e);
		if (!agg) continue;
		const staged = e.index !== 'unmodified' && e.index !== 'untracked' && e.index !== 'ignored';
		const unstaged =
			e.worktree !== 'unmodified' && e.worktree !== 'untracked' && e.worktree !== 'ignored';
		const s = statsByPath.get(e.path);
		entries.push({
			path: e.path,
			origPath: e.origPath,
			status: agg,
			staged,
			unstaged: unstaged || e.worktree === 'untracked',
			added: s?.added ?? null,
			removed: s?.removed ?? null
		});
	}
	entries.sort((a, b) => a.path.localeCompare(b.path));
	return json({ initialized: true, entries });
};
