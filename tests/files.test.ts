import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeResolve, listDir, readFileSafe } from '../src/lib/server/files';

let root: string;
let outside: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'files-test-'));
	outside = mkdtempSync(join(tmpdir(), 'files-outside-'));
	mkdirSync(join(root, 'sub'));
	writeFileSync(join(root, 'a.txt'), 'hello\n');
	writeFileSync(join(root, 'sub', 'b.txt'), 'world\n');
	writeFileSync(join(outside, 'secret.txt'), 'TOPSECRET');
	// Symlink that escapes the root.
	try {
		symlinkSync(outside, join(root, 'escape'));
	} catch {
		// symlinks may not be available on some CI; tests using it will skip.
	}
	// Binary file.
	writeFileSync(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 5]));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

describe('safeResolve', () => {
	it('resolves a simple relative path', () => {
		const r = safeResolve(root, 'a.txt');
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.rel).toBe('a.txt');
	});

	it('treats "" and "." as root', () => {
		expect(safeResolve(root, '').ok).toBe(true);
		expect(safeResolve(root, '.').ok).toBe(true);
	});

	it('rejects absolute paths', () => {
		const r = safeResolve(root, '/etc/passwd');
		expect(r.ok).toBe(false);
	});

	it('rejects "../" escape', () => {
		const r = safeResolve(root, '../foo');
		expect(r.ok).toBe(false);
	});

	it('rejects null bytes', () => {
		const r = safeResolve(root, 'a\0b');
		expect(r.ok).toBe(false);
	});

	it('rejects paths through escaping symlinks', () => {
		const r = safeResolve(root, 'escape/secret.txt');
		expect(r.ok).toBe(false);
	});
});

describe('listDir', () => {
	it('lists directories first, then files alphabetically', () => {
		const r = listDir(root, '');
		expect(r.ok).toBe(true);
		if (r.ok) {
			const names = r.entries.map((e) => e.name);
			// "sub" (dir) should come before files.
			expect(names.indexOf('sub')).toBeLessThan(names.indexOf('a.txt'));
		}
	});

	it('404s on missing dir', () => {
		const r = listDir(root, 'no-such-dir');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.status).toBe(404);
	});

	it('400s on escape attempt', () => {
		const r = listDir(root, '../');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.status).toBe(400);
	});
});

describe('readFileSafe', () => {
	it('reads text', async () => {
		const r = await readFileSafe(root, 'a.txt');
		expect(r.ok).toBe(true);
		if (r.ok && !('binary' in r && r.binary)) {
			expect((r as { content: string }).content).toBe('hello\n');
		}
	});

	it('detects binary', async () => {
		const r = await readFileSafe(root, 'bin.dat');
		expect(r.ok).toBe(true);
		if (r.ok) expect((r as { binary: boolean }).binary).toBe(true);
	});

	it('404s on missing', async () => {
		const r = await readFileSafe(root, 'no.txt');
		expect(r.ok).toBe(false);
	});
});
