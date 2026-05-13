// Thin, safe wrapper over the `git` CLI.
//
// All commands are spawned with `shell: false`, an explicit cwd, a hard
// timeout, and a capped output size. Path arguments are always validated
// against the workdir realpath via `files.safeResolve` and passed after a
// `--` separator so they can't be interpreted as flags.

import { spawn } from 'node:child_process';
import { safeResolve } from './files';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB

export interface GitRunResult {
	stdout: string;
	stderr: string;
	code: number;
	timedOut: boolean;
	truncated: boolean;
}

export class GitError extends Error {
	constructor(
		message: string,
		public readonly result: GitRunResult
	) {
		super(message);
		this.name = 'GitError';
	}
}

interface RunOptions {
	cwd: string;
	timeoutMs?: number;
	maxBytes?: number;
}

function runGit(args: string[], opts: RunOptions): Promise<GitRunResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	return new Promise((resolve) => {
		const child = spawn('git', args, {
			cwd: opts.cwd,
			shell: false,
			env: {
				...process.env,
				// Disable interactive prompts / pagers / hooks.
				GIT_TERMINAL_PROMPT: '0',
				GIT_PAGER: 'cat',
				PAGER: 'cat',
				GIT_OPTIONAL_LOCKS: '0',
				LC_ALL: 'C'
			}
		});
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		let truncated = false;
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, timeoutMs);

		child.stdout.on('data', (chunk: Buffer) => {
			if (stdout.length >= maxBytes) {
				truncated = true;
				return;
			}
			const room = maxBytes - stdout.length;
			stdout = Buffer.concat([stdout, chunk.subarray(0, room)]);
			if (chunk.length > room) {
				truncated = true;
				child.stdout.destroy();
			}
		});
		child.stderr.on('data', (chunk: Buffer) => {
			// Cap stderr at 64 KiB to avoid runaway logs.
			if (stderr.length < 65_536) {
				stderr = Buffer.concat([stderr, chunk.subarray(0, 65_536 - stderr.length)]);
			}
		});
		child.on('error', (err) => {
			clearTimeout(timer);
			resolve({
				stdout: stdout.toString('utf-8'),
				stderr: (stderr.toString('utf-8') + '\n' + err.message).trim(),
				code: -1,
				timedOut,
				truncated
			});
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({
				stdout: stdout.toString('utf-8'),
				stderr: stderr.toString('utf-8'),
				code: code ?? -1,
				timedOut,
				truncated
			});
		});
	});
}

async function runGitOk(args: string[], opts: RunOptions): Promise<string> {
	const r = await runGit(args, opts);
	if (r.timedOut) throw new GitError('git command timed out', r);
	if (r.code !== 0) throw new GitError(`git ${args[0]} exited ${r.code}: ${r.stderr.trim()}`, r);
	return r.stdout;
}

// ---------- Public API ----------

export interface RepoInitState {
	initialized: false;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
	const r = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd });
	return r.code === 0 && r.stdout.trim() === 'true';
}

export interface HeadInfo {
	initialized: true;
	branch: string | null;
	sha: string | null;
	shortSha: string | null;
	detached: boolean;
	upstream: string | null;
	ahead: number;
	behind: number;
	dirtyCount: number;
}

export async function headInfo(cwd: string): Promise<HeadInfo | RepoInitState> {
	if (!(await isGitRepo(cwd))) return { initialized: false };
	const sha = (await runGit(['rev-parse', 'HEAD'], { cwd })).stdout.trim() || null;
	const shortSha = sha ? sha.slice(0, 8) : null;
	const branchOut = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
	const branch = branchOut.code === 0 ? branchOut.stdout.trim() : null;
	const detached = branch === null;
	let upstream: string | null = null;
	let ahead = 0;
	let behind = 0;
	const upRes = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
		cwd
	});
	if (upRes.code === 0) {
		upstream = upRes.stdout.trim() || null;
		if (upstream) {
			const counts = await runGit(['rev-list', '--left-right', '--count', `HEAD...@{upstream}`], {
				cwd
			});
			if (counts.code === 0) {
				const [a, b] = counts.stdout.trim().split(/\s+/).map(Number);
				if (Number.isFinite(a)) ahead = a;
				if (Number.isFinite(b)) behind = b;
			}
		}
	}
	const statusOut = await runGit(['status', '--porcelain=v1', '-uall'], { cwd });
	const dirtyCount = statusOut.code === 0 ? statusOut.stdout.split('\n').filter(Boolean).length : 0;
	return {
		initialized: true,
		branch,
		sha,
		shortSha,
		detached,
		upstream,
		ahead,
		behind,
		dirtyCount
	};
}

export type StatusCode =
	| 'unmodified'
	| 'modified'
	| 'added'
	| 'deleted'
	| 'renamed'
	| 'copied'
	| 'updated'
	| 'untracked'
	| 'ignored'
	| 'conflicted';

export interface StatusEntry {
	/** POSIX-style path relative to repo root. */
	path: string;
	/** Original path for renames/copies. */
	origPath: string | null;
	/** Index (staged) status. */
	index: StatusCode;
	/** Working tree status. */
	worktree: StatusCode;
}

const STATUS_MAP: Record<string, StatusCode> = {
	' ': 'unmodified',
	M: 'modified',
	A: 'added',
	D: 'deleted',
	R: 'renamed',
	C: 'copied',
	U: 'updated',
	'?': 'untracked',
	'!': 'ignored'
};

function decodeStatusChar(c: string): StatusCode {
	return STATUS_MAP[c] ?? 'unmodified';
}

export interface StatusOptions {
	includeIgnored?: boolean;
}

/**
 * Returns one entry per changed (or untracked/ignored) path. Unchanged
 * tracked files are omitted to keep the response small; the UI merges
 * statuses into directory listings client-side or via `mergeStatusIntoTree`.
 */
export async function status(cwd: string, opts: StatusOptions = {}): Promise<StatusEntry[]> {
	const args = ['status', '--porcelain=v1', '-uall', '-z'];
	if (opts.includeIgnored) args.push('--ignored');
	const out = await runGitOk(args, { cwd });
	// -z output: entries separated by NUL. For R/C entries there are two
	// NUL-separated paths.
	const entries: StatusEntry[] = [];
	const parts = out.split('\0');
	for (let i = 0; i < parts.length; i++) {
		const rec = parts[i];
		if (!rec) continue;
		if (rec.length < 3) continue;
		const xy = rec.slice(0, 2);
		const path = rec.slice(3);
		let origPath: string | null = null;
		if (xy[0] === 'R' || xy[0] === 'C') {
			// Next part is the original path.
			origPath = parts[i + 1] ?? null;
			i++;
		}
		// Conflicted entries are codes like DD, AU, UD, UA, DU, AA, UU.
		const conflictPairs = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
		if (conflictPairs.has(xy)) {
			entries.push({ path, origPath, index: 'conflicted', worktree: 'conflicted' });
			continue;
		}
		if (xy === '??') {
			entries.push({ path, origPath, index: 'untracked', worktree: 'untracked' });
			continue;
		}
		if (xy === '!!') {
			entries.push({ path, origPath, index: 'ignored', worktree: 'ignored' });
			continue;
		}
		entries.push({
			path,
			origPath,
			index: decodeStatusChar(xy[0]),
			worktree: decodeStatusChar(xy[1])
		});
	}
	return entries;
}

export interface LogEntry {
	sha: string;
	shortSha: string;
	author: string;
	email: string;
	timestamp: number;
	subject: string;
}

const LOG_SEP = '\x1f';
const LOG_REC = '\x1e';
const LOG_FORMAT = ['%H', '%h', '%an', '%ae', '%at', '%s'].join(LOG_SEP) + LOG_REC;

export async function log(
	cwd: string,
	opts: { limit?: number; skip?: number; ref?: string } = {}
): Promise<LogEntry[]> {
	const limit = Math.min(opts.limit ?? 20, 200);
	const skip = Math.max(opts.skip ?? 0, 0);
	const args = ['log', `--max-count=${limit}`, `--skip=${skip}`, `--pretty=format:${LOG_FORMAT}`];
	if (opts.ref) {
		// Only allow refs matching a conservative pattern (no spaces, no
		// flags, no shell metacharacters).
		if (!/^[A-Za-z0-9._\-/@]+$/.test(opts.ref)) {
			throw new GitError('invalid ref', {
				stdout: '',
				stderr: 'invalid ref',
				code: -1,
				timedOut: false,
				truncated: false
			});
		}
		args.push(opts.ref);
	}
	const out = await runGitOk(args, { cwd });
	const records = out.split(LOG_REC).filter((s) => s.length > 0);
	return records.map((rec) => {
		const [sha, shortSha, author, email, ts, ...subjectParts] = rec.split(LOG_SEP);
		return {
			sha,
			shortSha,
			author,
			email,
			timestamp: Number(ts) * 1000,
			subject: subjectParts.join(LOG_SEP)
		};
	});
}

const SHA_RE = /^[0-9a-f]{4,64}$/;

export interface CommitFile {
	status: StatusCode;
	path: string;
	origPath: string | null;
}

export interface CommitDetail {
	sha: string;
	shortSha: string;
	author: string;
	email: string;
	timestamp: number;
	subject: string;
	body: string;
	parents: string[];
	files: CommitFile[];
}

export async function showCommit(cwd: string, sha: string): Promise<CommitDetail> {
	if (!SHA_RE.test(sha)) throw new GitError('invalid sha', emptyResult());
	const SEP = '\x1f';
	const fmt = ['%H', '%h', '%an', '%ae', '%at', '%P', '%s', '%b'].join(SEP);
	const meta = await runGitOk(['show', '-s', `--pretty=format:${fmt}`, sha], { cwd });
	const [full, shortSha, author, email, ts, parentsRaw, subject, ...bodyParts] = meta.split(SEP);
	const parents = parentsRaw.trim() ? parentsRaw.trim().split(/\s+/) : [];
	// Changed files via name-status.
	const nameStatus = await runGitOk(['show', '--name-status', '--format=', '-z', sha], { cwd });
	const files: CommitFile[] = [];
	const parts = nameStatus.split('\0').filter(Boolean);
	for (let i = 0; i < parts.length; i++) {
		const code = parts[i];
		// Status codes: M, A, D, T, R100, C75, ...
		const head = code[0];
		if (head === 'R' || head === 'C') {
			const orig = parts[++i] ?? '';
			const dest = parts[++i] ?? '';
			files.push({
				status: head === 'R' ? 'renamed' : 'copied',
				path: dest,
				origPath: orig
			});
		} else {
			const path = parts[++i] ?? '';
			files.push({
				status: decodeStatusChar(head),
				path,
				origPath: null
			});
		}
	}
	return {
		sha: full,
		shortSha,
		author,
		email,
		timestamp: Number(ts) * 1000,
		subject,
		body: bodyParts.join(SEP).trim(),
		parents,
		files
	};
}

export type DiffTarget =
	| { kind: 'worktree-vs-head' }
	| { kind: 'worktree-vs-index' }
	| { kind: 'index-vs-head' }
	| { kind: 'commit'; sha: string }
	| { kind: 'commit-vs-parent'; sha: string };

/**
 * Returns a unified diff for an optional path. If `relPath` is provided it
 * must be resolvable inside `cwd`.
 */
export async function diff(cwd: string, target: DiffTarget, relPath?: string): Promise<string> {
	let pathArgs: string[] = [];
	if (relPath !== undefined && relPath !== '') {
		const r = safeResolve(cwd, relPath);
		if (!r.ok) throw new GitError(`invalid path: ${r.reason}`, emptyResult());
		pathArgs = ['--', r.rel];
	}
	const baseArgs = ['diff', '--no-color', '--no-ext-diff'];
	let args: string[];
	switch (target.kind) {
		case 'worktree-vs-head':
			args = [...baseArgs, 'HEAD', ...pathArgs];
			break;
		case 'worktree-vs-index':
			args = [...baseArgs, ...pathArgs];
			break;
		case 'index-vs-head':
			args = [...baseArgs, '--cached', ...pathArgs];
			break;
		case 'commit': {
			if (!SHA_RE.test(target.sha)) throw new GitError('invalid sha', emptyResult());
			args = [...baseArgs, `${target.sha}^!`, ...pathArgs];
			break;
		}
		case 'commit-vs-parent': {
			if (!SHA_RE.test(target.sha)) throw new GitError('invalid sha', emptyResult());
			args = [...baseArgs, `${target.sha}^`, target.sha, ...pathArgs];
			break;
		}
	}
	return await runGitOk(args, { cwd, maxBytes: DEFAULT_MAX_BYTES });
}

/** Read a file at a specific revision. */
export async function showFile(cwd: string, ref: string, relPath: string): Promise<string> {
	if (!/^[A-Za-z0-9._\-/@^~]+$/.test(ref)) throw new GitError('invalid ref', emptyResult());
	const r = safeResolve(cwd, relPath);
	if (!r.ok) throw new GitError(`invalid path: ${r.reason}`, emptyResult());
	return await runGitOk(['show', `${ref}:${r.rel}`], { cwd });
}

function emptyResult(): GitRunResult {
	return { stdout: '', stderr: '', code: -1, timedOut: false, truncated: false };
}
