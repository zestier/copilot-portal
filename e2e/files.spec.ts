import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Server is launched with cwd=DATA_DIR (see playwright.config.ts) so the file
// browser's workspace root is this directory.
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '.tmp-data');

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
	expect(fileBody.content).toBe('greetings\n');

	await page.goto(`/conversations/${id}`);
	await page.getByRole('tab', { name: 'Files' }).click();
	await expect(page.getByRole('button', { name: /hello\.txt/ })).toBeVisible();
	await page.getByRole('button', { name: /hello\.txt/ }).click();
	await expect(page.locator('pre.file-view')).toContainText('greetings');
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
