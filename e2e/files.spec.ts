import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

async function createConversation(request: import('@playwright/test').APIRequestContext) {
	const res = await request.post('/api/conversations', { data: { title: 'E2E files' } });
	expect(res.ok()).toBeTruthy();
	const body = await res.json();
	return { id: body.conversation.id as string, workdir: body.conversation.workdir as string };
}

test('Files tab lists workspace contents and reads a file', async ({ page, request }) => {
	const { id, workdir } = await createConversation(request);
	// Drop a file at the conversation's workdir.
	writeFileSync(join(workdir, 'hello.txt'), 'greetings\n');
	mkdirSync(join(workdir, 'sub'), { recursive: true });
	writeFileSync(join(workdir, 'sub', 'inner.txt'), 'nested\n');

	const tree = await request.get(`/api/conversations/${id}/fs/tree`);
	expect(tree.ok()).toBeTruthy();
	const treeBody = await tree.json();
	const names = treeBody.entries.map((e: { name: string }) => e.name);
	expect(names).toContain('hello.txt');
	expect(names).toContain('sub');

	const file = await request.get(`/api/conversations/${id}/fs/file?path=hello.txt`);
	expect(file.ok()).toBeTruthy();
	const fileBody = await file.json();
	expect(fileBody.file.content).toBe('greetings\n');

	await page.goto(`/conversations/${id}`);
	await page.getByRole('tab', { name: 'Files' }).click();
	// FileBrowser defaults to the Changes pane; switch to the file tree.
	await page.getByRole('tab', { name: 'All files' }).click();
	await expect(page.getByRole('button', { name: /hello\.txt/ })).toBeVisible();
	await page.getByRole('button', { name: /hello\.txt/ }).click();
	await expect(page.locator('pre.file-view')).toContainText('greetings');
});

test('fs and git routes are scoped to the conversation workdir', async ({ request }) => {
	// Two conversations get two distinct workdirs; files and git history in one
	// must not leak into the other's fs/git endpoints.
	const a = await createConversation(request);
	const b = await createConversation(request);
	expect(a.workdir).not.toBe(b.workdir);

	writeFileSync(join(a.workdir, 'only-in-a.txt'), 'A\n');
	writeFileSync(join(b.workdir, 'only-in-b.txt'), 'B\n');

	const treeA = await (await request.get(`/api/conversations/${a.id}/fs/tree`)).json();
	const treeB = await (await request.get(`/api/conversations/${b.id}/fs/tree`)).json();
	const namesA = treeA.entries.map((e: { name: string }) => e.name);
	const namesB = treeB.entries.map((e: { name: string }) => e.name);
	expect(namesA).toContain('only-in-a.txt');
	expect(namesA).not.toContain('only-in-b.txt');
	expect(namesB).toContain('only-in-b.txt');
	expect(namesB).not.toContain('only-in-a.txt');

	// Reading B's file via A's conversation id must fail (not found in A).
	const cross = await request.get(`/api/conversations/${a.id}/fs/file?path=only-in-b.txt`);
	expect(cross.ok()).toBeFalsy();

	// Init a git repo only in A; B's git endpoints must report uninitialized.
	const g = (args: string[]) => execFileSync('git', args, { cwd: a.workdir, stdio: 'pipe' });
	g(['init', '-q', '-b', 'main']);
	g(['config', 'user.email', 'e2e@example.com']);
	g(['config', 'user.name', 'E2E']);
	g(['config', 'commit.gpgsign', 'false']);
	g(['add', '.']);
	g(['commit', '-q', '-m', 'a-baseline']);

	const logA = await (await request.get(`/api/conversations/${a.id}/git/log`)).json();
	const logB = await (await request.get(`/api/conversations/${b.id}/git/log`)).json();
	expect(logA.initialized).toBe(true);
	expect(logA.commits.length).toBeGreaterThan(0);
	expect(logB.initialized).toBe(false);
	expect(logB.commits).toEqual([]);
});

test('Files tab reports git status when workspace is a repo', async ({ request }) => {
	const { id, workdir } = await createConversation(request);
	// Init a fresh git repo in a subdirectory of the conversation workdir, then
	// drive the FS endpoints by navigating into it via ?path=.
	const repo = join(workdir, 'repo');
	mkdirSync(repo, { recursive: true });
	execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
	execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: repo });
	execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: repo });
	execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
	writeFileSync(join(repo, 'a.txt'), 'one\n');
	execFileSync('git', ['add', '.'], { cwd: repo });
	execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repo });
	writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
	writeFileSync(join(repo, 'new.txt'), 'fresh\n');

	// The conversation's workdir itself isn't a repo, so the top-level git
	// endpoints return uninitialized; the per-path file tree still works, and
	// we verify the embedded repo's files appear under ?path=repo.
	const tree = await request.get(`/api/conversations/${id}/fs/tree?path=repo`);
	expect(tree.ok()).toBeTruthy();
	const treeBody = await tree.json();
	const names = treeBody.entries.map((e: { name: string }) => e.name);
	expect(names).toContain('a.txt');
	expect(names).toContain('new.txt');
});

test('Changes tab lists modified files with +/- stats and a working diff', async ({
	page,
	request
}) => {
	const { id, workdir } = await createConversation(request);

	// Initialise the conversation workdir itself as a repo so /git/changes
	// (which runs against it) returns real data.
	const g = (args: string[]) => execFileSync('git', args, { cwd: workdir, stdio: 'pipe' });
	g(['init', '-q', '-b', 'main']);
	g(['config', 'user.email', 'e2e@example.com']);
	g(['config', 'user.name', 'E2E']);
	g(['config', 'commit.gpgsign', 'false']);
	writeFileSync(join(workdir, 'tracked.txt'), 'one\ntwo\nthree\n');
	mkdirSync(join(workdir, 'pkg'), { recursive: true });
	writeFileSync(join(workdir, 'pkg', 'mod.txt'), 'alpha\nbeta\n');
	g(['add', 'tracked.txt', 'pkg/mod.txt']);
	g(['commit', '-q', '-m', 'baseline']);
	// Now make a working-tree change: 2 lines added, 1 removed in tracked.txt.
	writeFileSync(join(workdir, 'tracked.txt'), 'one\nTWO\nthree\nfour\nfive\n');
	// And an addition deep inside a directory so we can check folder aggregation.
	writeFileSync(join(workdir, 'pkg', 'mod.txt'), 'alpha\nbeta\ngamma\n');

	// --- API: /git/changes shape and line counts ------------------------
	const changesRes = await request.get(`/api/conversations/${id}/git/changes`);
	expect(changesRes.ok()).toBeTruthy();
	const changes = await changesRes.json();
	expect(changes.initialized).toBe(true);
	const byPath = Object.fromEntries(
		(changes.entries as Array<{ path: string; added: number | null; removed: number | null }>).map(
			(e) => [e.path, e]
		)
	);
	expect(byPath['tracked.txt']).toMatchObject({ status: 'modified', added: 3, removed: 1 });
	expect(byPath['pkg/mod.txt']).toMatchObject({ status: 'modified', added: 1, removed: 0 });

	// --- API: /fs/tree exposes per-file and per-directory stats ---------
	const treeRoot = await (await request.get(`/api/conversations/${id}/fs/tree`)).json();
	const rootByName = Object.fromEntries(
		(
			treeRoot.entries as Array<{
				name: string;
				type: string;
				added: number | null;
				removed: number | null;
			}>
		).map((e) => [e.name, e])
	);
	expect(rootByName['tracked.txt']).toMatchObject({ added: 3, removed: 1 });
	// Directory aggregate rolls up its descendants' line counts.
	expect(rootByName['pkg']).toMatchObject({ type: 'directory', added: 1, removed: 0 });

	// --- UI: Changes tab is the default pane; shows entries with +/- and diff
	await page.goto(`/conversations/${id}`);
	await page.getByRole('tab', { name: 'Files' }).click();
	const changesTab = page.getByRole('tab', { name: 'Changes' });
	await expect(changesTab).toBeVisible();
	await expect(changesTab).toHaveAttribute('aria-selected', 'true');
	const row = page.getByRole('button', { name: /tracked\.txt/ });
	await expect(row).toBeVisible();
	await expect(row).toContainText('+3');
	await expect(row).toContainText('−1');

	await row.click();
	const diff = page.locator('.diff');
	await expect(diff).toBeVisible();
	// Diff header shows aggregate stats.
	await expect(diff.locator('.stats .added')).toHaveText('+3');
	await expect(diff.locator('.stats .removed')).toHaveText('−1');
	// At least one add and one del line are rendered with line numbers.
	await expect(diff.locator('.line.add').first()).toBeVisible();
	await expect(diff.locator('.line.del').first()).toBeVisible();
	await expect(diff.locator('.line.add .gutter.new').first()).not.toHaveText('');
});
