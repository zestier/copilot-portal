import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

function setupTmpDataDir() {
	const dir = mkdtempSync(join(tmpdir(), 'portal-snap-test-'));
	process.env.DATA_DIR = dir;
	process.env.HOST = '127.0.0.1';
	process.env.AUTH_MODE = 'none';
	process.env.I_KNOW_THIS_IS_LOCAL = '1';
	delete process.env.SESSION_SECRET;
	return dir;
}

async function freshImports() {
	const { resetConfigForTests } = await import('../src/lib/server/config');
	resetConfigForTests();
	const { closeDb } = await import('../src/lib/server/db');
	closeDb();
	const users = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const messages = await import('../src/lib/server/db/repos/messages');
	const snapshots = await import('../src/lib/server/snapshots');
	return { users, convs, messages, snapshots };
}

describe('snapshots', () => {
	let workdir: string;

	beforeEach(() => {
		setupTmpDataDir();
		workdir = mkdtempSync(join(tmpdir(), 'portal-snap-wd-'));
	});

	it('initialises a git repo on first snapshot and binds it to a ref', async () => {
		const { users, convs, messages, snapshots } = await freshImports();
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 't', workdir, model: null });
		const m = messages.append(c.id, { role: 'user', content: 'hi' });

		writeFileSync(join(workdir, 'a.txt'), 'one\n');
		const row = await snapshots.snapshot(workdir, m.id, 'pre');

		expect(row.messageId).toBe(m.id);
		expect(row.kind).toBe('pre');
		expect(row.commitSha).toMatch(/^[0-9a-f]{40}$/);
		expect(row.treeSha).toMatch(/^[0-9a-f]{40}$/);
		expect(row.gitRef).toBe(`refs/portal/turns/pre/${m.id}`);
		// The ref must actually exist in the repo.
		const refSha = execFileSync('git', ['rev-parse', row.gitRef], { cwd: workdir })
			.toString()
			.trim();
		expect(refSha).toBe(row.commitSha);
	});

	it('returns the existing row when snapshotting the same (messageId, kind) twice', async () => {
		const { users, convs, messages, snapshots } = await freshImports();
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 't', workdir, model: null });
		const m = messages.append(c.id, { role: 'user', content: 'hi' });

		writeFileSync(join(workdir, 'a.txt'), 'one\n');
		const r1 = await snapshots.snapshot(workdir, m.id, 'pre');
		writeFileSync(join(workdir, 'a.txt'), 'two\n');
		const r2 = await snapshots.snapshot(workdir, m.id, 'pre');
		// Same row returned; the second snapshot is a no-op even though
		// the worktree changed.
		expect(r2.commitSha).toBe(r1.commitSha);
		expect(r2.treeSha).toBe(r1.treeSha);
	});

	it('dedupes tree SHA when content is identical across messages', async () => {
		const { users, convs, messages, snapshots } = await freshImports();
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 't', workdir, model: null });
		const m1 = messages.append(c.id, { role: 'user', content: 'a' });
		const m2 = messages.append(c.id, { role: 'user', content: 'b' });

		writeFileSync(join(workdir, 'a.txt'), 'same\n');
		const r1 = await snapshots.snapshot(workdir, m1.id, 'pre');
		const r2 = await snapshots.snapshot(workdir, m2.id, 'pre');
		expect(r1.treeSha).toBe(r2.treeSha);
		// Commits differ (different message in subject line).
		expect(r1.commitSha).not.toBe(r2.commitSha);
	});

	it('captures untracked files in the snapshot tree', async () => {
		const { users, convs, messages, snapshots } = await freshImports();
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 't', workdir, model: null });
		const m = messages.append(c.id, { role: 'user', content: 'hi' });

		mkdirSync(join(workdir, 'sub'));
		writeFileSync(join(workdir, 'sub', 'new.txt'), 'untracked\n');
		const row = await snapshots.snapshot(workdir, m.id, 'pre');
		const out = execFileSync('git', ['ls-tree', '-r', row.commitSha], { cwd: workdir }).toString();
		expect(out).toContain('sub/new.txt');
	});

	it('materializeFromCommit reproduces the exact worktree in a new dir', async () => {
		const { users, convs, messages, snapshots } = await freshImports();
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 't', workdir, model: null });
		const m = messages.append(c.id, { role: 'user', content: 'hi' });

		writeFileSync(join(workdir, 'a.txt'), 'hello\n');
		mkdirSync(join(workdir, 'd'));
		writeFileSync(join(workdir, 'd', 'b.txt'), 'world\n');
		const row = await snapshots.snapshot(workdir, m.id, 'pre');

		// Mutate the source after the snapshot.
		writeFileSync(join(workdir, 'a.txt'), 'changed\n');
		rmSync(join(workdir, 'd'), { recursive: true });
		writeFileSync(join(workdir, 'late.txt'), 'late\n');

		const dst = mkdtempSync(join(tmpdir(), 'portal-snap-dst-'));
		rmSync(dst, { recursive: true });
		await snapshots.materializeFromCommit(workdir, row.commitSha, dst);
		expect(readFileSync(join(dst, 'a.txt'), 'utf8')).toBe('hello\n');
		expect(readFileSync(join(dst, 'd', 'b.txt'), 'utf8')).toBe('world\n');
		expect(existsSync(join(dst, 'late.txt'))).toBe(false);
	});

	it('does not pollute the workdir staging area', async () => {
		const { users, convs, messages, snapshots } = await freshImports();
		const u = users.ensureLocalUser();
		const c = convs.create(u.id, { title: 't', workdir, model: null });
		const m = messages.append(c.id, { role: 'user', content: 'hi' });

		writeFileSync(join(workdir, 'a.txt'), 'one\n');
		await snapshots.snapshot(workdir, m.id, 'pre');
		// The user's normal index should still be empty (no `git add` ran
		// against it).
		const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
			cwd: workdir
		}).toString();
		expect(staged.trim()).toBe('');
	});
});
