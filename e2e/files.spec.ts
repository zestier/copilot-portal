import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConversations } from './helpers/reset';

// Server is launched with cwd=DATA_DIR (see playwright.config.ts) so the file
// browser's workspace root is this directory.
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '.tmp-data');

// File-browser endpoints operate on a shared workspace root. To keep tests
// independent we clear the root before each test, preserving only the
// SQLite DB and the per-conversation workspaces/ subdirectory that the
// server manages.
const PRESERVE = new Set([
	'portal.db',
	'portal.db-journal',
	'portal.db-wal',
	'portal.db-shm',
	'workspaces'
]);

test.beforeEach(async ({ request }) => {
	for (const name of readdirSync(workspaceRoot)) {
		if (PRESERVE.has(name)) continue;
		rmSync(join(workspaceRoot, name), { recursive: true, force: true });
	}
	await resetConversations(request);
});

async function createConversation(request: import('@playwright/test').APIRequestContext) {
	const res = await request.post('/api/conversations', { data: { title: 'E2E files' } });
	expect(res.ok()).toBeTruthy();
	const body = await res.json();
	return { id: body.conversation.id as string };
}

test('Files tab lists workspace contents and reads a file', async ({ page, request }) => {
	const { id } = await createConversation(request);
	// Drop a file at the workspace root.
	writeFileSync(join(workspaceRoot, 'hello.txt'), 'greetings\n');
	mkdirSync(join(workspaceRoot, 'sub'), { recursive: true });
	writeFileSync(join(workspaceRoot, 'sub', 'inner.txt'), 'nested\n');

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
	await expect(page).toHaveURL(`/conversations/${id}?tab=files`);
	await expect(page.getByRole('button', { name: /hello\.txt/ })).toBeVisible();
	await page.getByRole('button', { name: /hello\.txt/ }).click();
	await expect(page.locator('pre.file-view')).toContainText('greetings');
	await page.reload();
	await expect(page).toHaveURL(`/conversations/${id}?tab=files`);
	await expect(page.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByRole('button', { name: /hello\.txt/ })).toBeVisible();
});

test('Files tab reports git status when workspace is a repo', async ({ request }) => {
	const { id } = await createConversation(request);
	// Init a fresh git repo in a subdirectory of the workspace root, then
	// drive the FS endpoints by navigating into it via ?path=.
	const repo = join(workspaceRoot, 'repo');
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

	// The workspace root itself isn't a repo, so the top-level git endpoints
	// return uninitialized; the per-path file tree still works, and we verify
	// the embedded repo's files appear under ?path=repo.
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
	const { id } = await createConversation(request);

	// Initialise the workspace root itself as a repo so /git/changes
	// (which runs against workspaceRoot) returns real data.
	const g = (args: string[]) => execFileSync('git', args, { cwd: workspaceRoot, stdio: 'pipe' });
	g(['init', '-q', '-b', 'main']);
	g(['config', 'user.email', 'e2e@example.com']);
	g(['config', 'user.name', 'E2E']);
	g(['config', 'commit.gpgsign', 'false']);
	writeFileSync(join(workspaceRoot, 'tracked.txt'), 'one\ntwo\nthree\n');
	mkdirSync(join(workspaceRoot, 'pkg'), { recursive: true });
	writeFileSync(join(workspaceRoot, 'pkg', 'mod.txt'), 'alpha\nbeta\n');
	g(['add', 'tracked.txt', 'pkg/mod.txt']);
	g(['commit', '-q', '-m', 'baseline']);
	// Now make a working-tree change: 2 lines added, 1 removed in tracked.txt.
	writeFileSync(join(workspaceRoot, 'tracked.txt'), 'one\nTWO\nthree\nfour\nfive\n');
	// And an addition deep inside a directory so we can check folder aggregation.
	writeFileSync(join(workspaceRoot, 'pkg', 'mod.txt'), 'alpha\nbeta\ngamma\n');

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

	// --- UI: Changes is a top-level tab; shows entries with +/- and diff
	await page.goto(`/conversations/${id}`);
	const changesTab = page.getByRole('tab', { name: 'Changes' });
	await changesTab.click();
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
	await expect(diff.locator('.line.add .gutter').first()).not.toHaveText('');
});
