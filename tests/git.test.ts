import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as git from '../src/lib/server/git';

let repo: string;
let firstSha = '';

function g(args: string[], cwd = repo) {
	execFileSync('git', args, { cwd, stdio: 'pipe' });
}

beforeAll(() => {
	repo = mkdtempSync(join(tmpdir(), 'gitwrap-'));
	g(['init', '-q', '-b', 'main']);
	g(['config', 'user.email', 'test@example.com']);
	g(['config', 'user.name', 'Test']);
	g(['config', 'commit.gpgsign', 'false']);
	writeFileSync(join(repo, 'a.txt'), 'hello\n');
	mkdirSync(join(repo, 'sub'));
	writeFileSync(join(repo, 'sub', 'b.txt'), 'one\ntwo\n');
	g(['add', '.']);
	g(['commit', '-q', '-m', 'initial']);
	firstSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
	// Make some changes for status/diff tests.
	writeFileSync(join(repo, 'a.txt'), 'hello\nchanged\n');
	writeFileSync(join(repo, 'new.txt'), 'fresh\n');
});

afterAll(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe('isGitRepo / headInfo', () => {
	it('detects a repo', async () => {
		expect(await git.isGitRepo(repo)).toBe(true);
	});
	it('reports branch + sha + dirtyCount', async () => {
		const info = await git.headInfo(repo);
		expect(info.initialized).toBe(true);
		if (info.initialized) {
			expect(info.branch).toBe('main');
			expect(info.sha).toMatch(/^[0-9a-f]{40}$/);
			expect(info.dirtyCount).toBeGreaterThanOrEqual(2);
		}
	});
	it('non-repo returns initialized:false', async () => {
		const tmp = mkdtempSync(join(tmpdir(), 'norepo-'));
		try {
			const info = await git.headInfo(tmp);
			expect(info.initialized).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe('status', () => {
	it('reports modified + untracked entries', async () => {
		const entries = await git.status(repo);
		const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));
		expect(byPath['a.txt']?.worktree).toBe('modified');
		expect(byPath['new.txt']?.worktree).toBe('untracked');
	});
});

describe('log', () => {
	it('returns recent commits', async () => {
		const entries = await git.log(repo, { limit: 5 });
		expect(entries.length).toBeGreaterThanOrEqual(1);
		expect(entries[0].subject).toBe('initial');
		expect(entries[0].sha).toMatch(/^[0-9a-f]{40}$/);
	});
});

describe('diff', () => {
	it('diffs worktree vs HEAD', async () => {
		const d = await git.diff(repo, { kind: 'worktree-vs-head' });
		expect(d).toContain('a.txt');
		expect(d).toContain('+changed');
	});
	it('diffs single file', async () => {
		const d = await git.diff(repo, { kind: 'worktree-vs-head' }, 'a.txt');
		expect(d).toContain('a.txt');
		expect(d).not.toMatch(/diff --git a\/new\.txt/);
	});
	it('rejects path escape', async () => {
		await expect(git.diff(repo, { kind: 'worktree-vs-head' }, '../escape')).rejects.toThrow();
	});
});

describe('showCommit / showFile', () => {
	it('returns commit detail and file list', async () => {
		const c = await git.showCommit(repo, firstSha);
		expect(c.subject).toBe('initial');
		const paths = c.files.map((f) => f.path).sort();
		expect(paths).toContain('a.txt');
		expect(paths).toContain('sub/b.txt');
	});
	it('reads file at revision', async () => {
		const out = await git.showFile(repo, firstSha, 'a.txt');
		expect(out).toBe('hello\n');
	});
	it('rejects invalid sha', async () => {
		await expect(git.showCommit(repo, 'not-a-sha!!')).rejects.toThrow();
	});
});
