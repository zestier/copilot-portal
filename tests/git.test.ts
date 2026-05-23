import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
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

describe('discardAllLocalChanges', () => {
	it('resets tracked changes and removes untracked files without removing ignored files', async () => {
		const tmp = mkdtempSync(join(tmpdir(), 'gitwrap-discard-'));
		try {
			const run = (args: string[]) => execFileSync('git', args, { cwd: tmp, stdio: 'pipe' });
			run(['init', '-q', '-b', 'main']);
			run(['config', 'user.email', 't@example.com']);
			run(['config', 'user.name', 'T']);
			run(['config', 'commit.gpgsign', 'false']);
			writeFileSync(join(tmp, '.gitignore'), 'ignored.txt\n');
			writeFileSync(join(tmp, 'tracked.txt'), 'original\n');
			run(['add', '.']);
			run(['commit', '-q', '-m', 'init']);

			writeFileSync(join(tmp, 'tracked.txt'), 'changed\n');
			writeFileSync(join(tmp, 'staged.txt'), 'staged\n');
			run(['add', 'staged.txt']);
			writeFileSync(join(tmp, 'untracked.txt'), 'untracked\n');
			writeFileSync(join(tmp, 'ignored.txt'), 'ignored\n');

			await git.discardAllLocalChanges(tmp);

			expect(readFileSync(join(tmp, 'tracked.txt'), 'utf8')).toBe('original\n');
			expect(existsSync(join(tmp, 'staged.txt'))).toBe(false);
			expect(existsSync(join(tmp, 'untracked.txt'))).toBe(false);
			expect(existsSync(join(tmp, 'ignored.txt'))).toBe(true);
			expect(await git.status(tmp)).toEqual([]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it('removes staged and unstaged files from repositories without commits', async () => {
		const tmp = mkdtempSync(join(tmpdir(), 'gitwrap-discard-unborn-'));
		try {
			const run = (args: string[]) => execFileSync('git', args, { cwd: tmp, stdio: 'pipe' });
			run(['init', '-q', '-b', 'main']);
			writeFileSync(join(tmp, 'staged.txt'), 'staged\n');
			run(['add', 'staged.txt']);
			writeFileSync(join(tmp, 'untracked.txt'), 'untracked\n');

			await git.discardAllLocalChanges(tmp);

			expect(existsSync(join(tmp, 'staged.txt'))).toBe(false);
			expect(existsSync(join(tmp, 'untracked.txt'))).toBe(false);
			expect(await git.status(tmp)).toEqual([]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
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

describe('numstat', () => {
	it('reports added/removed lines per tracked file vs HEAD', async () => {
		const stats = await git.numstat(repo, { kind: 'worktree-vs-head' });
		const byPath = Object.fromEntries(stats.map((s) => [s.path, s]));
		// a.txt: one line added ("changed\n"), zero removed.
		expect(byPath['a.txt']).toBeDefined();
		expect(byPath['a.txt']?.added).toBe(1);
		expect(byPath['a.txt']?.removed).toBe(0);
		// new.txt is untracked so it does not appear in diff vs HEAD.
		expect(byPath['new.txt']).toBeUndefined();
	});

	it('handles renames as a single entry with origPath', async () => {
		const tmp = mkdtempSync(join(tmpdir(), 'gitwrap-rename-'));
		try {
			const run = (args: string[]) => execFileSync('git', args, { cwd: tmp, stdio: 'pipe' });
			run(['init', '-q', '-b', 'main']);
			run(['config', 'user.email', 't@example.com']);
			run(['config', 'user.name', 'T']);
			run(['config', 'commit.gpgsign', 'false']);
			writeFileSync(join(tmp, 'old.txt'), 'one\ntwo\nthree\n');
			run(['add', '.']);
			run(['commit', '-q', '-m', 'init']);
			run(['mv', 'old.txt', 'new.txt']);
			writeFileSync(join(tmp, 'new.txt'), 'one\ntwo\nthree\nfour\n');
			const stats = await git.numstat(tmp, { kind: 'worktree-vs-head' });
			const rename = stats.find((s) => s.path === 'new.txt');
			expect(rename).toBeDefined();
			expect(rename?.origPath).toBe('old.txt');
			expect(rename?.added).toBe(1);
			expect(rename?.removed).toBe(0);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it('reports null counts for binary files', async () => {
		const tmp = mkdtempSync(join(tmpdir(), 'gitwrap-bin-'));
		try {
			const run = (args: string[]) => execFileSync('git', args, { cwd: tmp, stdio: 'pipe' });
			run(['init', '-q', '-b', 'main']);
			run(['config', 'user.email', 't@example.com']);
			run(['config', 'user.name', 'T']);
			run(['config', 'commit.gpgsign', 'false']);
			writeFileSync(join(tmp, 'data.bin'), Buffer.from([0, 1, 2, 0, 0, 3]));
			run(['add', '.']);
			run(['commit', '-q', '-m', 'init']);
			writeFileSync(join(tmp, 'data.bin'), Buffer.from([0, 0, 0, 0, 0, 4, 5]));
			const stats = await git.numstat(tmp, { kind: 'worktree-vs-head' });
			const bin = stats.find((s) => s.path === 'data.bin');
			expect(bin).toBeDefined();
			expect(bin?.added).toBeNull();
			expect(bin?.removed).toBeNull();
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
