import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

async function createConversation(request: import('@playwright/test').APIRequestContext) {
	const res = await request.post('/api/conversations', { data: { title: 'E2E files' } });
	expect(res.ok()).toBeTruthy();
	const body = await res.json();
	return {
		id: body.conversation.id as string,
		workdir: body.conversation.workdir as string
	};
}

test('Files tab lists workdir contents and reads a file', async ({ page, request }) => {
	const { id, workdir } = await createConversation(request);
	// Drop a file into the conversation's workdir.
	writeFileSync(join(workdir, 'hello.txt'), 'greetings\n');
	mkdirSync(join(workdir, 'sub'), { recursive: true });
	writeFileSync(join(workdir, 'sub', 'inner.txt'), 'nested\n');

	// API: tree returns the entries.
	const tree = await request.get(`/api/conversations/${id}/fs/tree`);
	expect(tree.ok()).toBeTruthy();
	const treeBody = await tree.json();
	const names = treeBody.entries.map((e: { name: string }) => e.name);
	expect(names).toContain('hello.txt');
	expect(names).toContain('sub');

	// API: read file.
	const file = await request.get(`/api/conversations/${id}/fs/file?path=hello.txt`);
	expect(file.ok()).toBeTruthy();
	const fileBody = await file.json();
	expect(fileBody.content).toBe('greetings\n');

	// UI: Files tab shows the file.
	await page.goto(`/conversations/${id}`);
	await page.getByRole('tab', { name: 'Files' }).click();
	await expect(page.getByRole('button', { name: /hello\.txt/ })).toBeVisible();
	await page.getByRole('button', { name: /hello\.txt/ }).click();
	await expect(page.locator('pre.file-view')).toContainText('greetings');
});

test('Files tab reports git status when workdir is a repo', async ({ request }) => {
	const { id, workdir } = await createConversation(request);
	execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workdir });
	execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: workdir });
	execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: workdir });
	execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: workdir });
	writeFileSync(join(workdir, 'a.txt'), 'one\n');
	execFileSync('git', ['add', '.'], { cwd: workdir });
	execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: workdir });
	writeFileSync(join(workdir, 'a.txt'), 'one\ntwo\n');
	writeFileSync(join(workdir, 'new.txt'), 'fresh\n');

	const status = await request.get(`/api/conversations/${id}/git/status`);
	expect(status.ok()).toBeTruthy();
	const sBody = await status.json();
	expect(sBody.initialized).toBe(true);
	expect(sBody.branch).toBe('main');
	expect(sBody.dirtyCount).toBeGreaterThanOrEqual(2);

	const tree = await request.get(`/api/conversations/${id}/fs/tree`);
	const treeBody = await tree.json();
	const byName = Object.fromEntries(
		treeBody.entries.map((e: { name: string; status: string | null }) => [e.name, e.status])
	);
	expect(byName['a.txt']).toBe('modified');
	expect(byName['new.txt']).toBe('untracked');

	const log = await request.get(`/api/conversations/${id}/git/log`);
	const logBody = await log.json();
	expect(logBody.initialized).toBe(true);
	expect(logBody.commits.length).toBeGreaterThanOrEqual(1);
	expect(logBody.commits[0].subject).toBe('initial');
});
