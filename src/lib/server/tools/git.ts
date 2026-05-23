import { z } from 'zod';
import {
	aggregateStatus,
	diff,
	headInfo,
	isGitRepo,
	log,
	showCommit,
	showFile,
	status,
	type DiffTarget
} from '../git';

export interface PortalTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	permissionBehavior?: 'normal' | 'always-prompt';
	handler(args: unknown): Promise<string>;
}

const TargetKind = z.enum([
	'worktree-vs-head',
	'worktree-vs-index',
	'index-vs-head',
	'commit',
	'commit-vs-parent'
]);

const GitStatusArgs = z
	.object({
		includeIgnored: z.boolean().optional().default(false)
	})
	.optional()
	.default({});

const GitDiffArgs = z
	.object({
		target: TargetKind.optional().default('worktree-vs-head'),
		sha: z.string().min(4).max(64).optional(),
		path: z.string().min(1).max(4096).optional()
	})
	.refine((args) => !requiresSha(args.target) || args.sha !== undefined, {
		path: ['sha'],
		message: 'sha is required when target is commit or commit-vs-parent'
	})
	.optional()
	.default({});

const GitLogArgs = z
	.object({
		limit: z.number().int().min(1).max(50).optional().default(20),
		skip: z.number().int().min(0).max(1000).optional().default(0),
		ref: z.string().min(1).max(200).optional()
	})
	.optional()
	.default({});

const GitShowCommitArgs = z.object({
	sha: z.string().min(4).max(64)
});

const GitShowFileArgs = z.object({
	ref: z.string().min(1).max(200),
	path: z.string().min(1).max(4096)
});

export function buildGitTools(cwd: string): PortalTool[] {
	return [
		{
			name: 'git_status',
			description:
				'Structured replacement for `git status`. Reports repository head and changed files without allowing arbitrary git shell flags or mutating subcommands.',
			parameters: {
				type: 'object',
				properties: {
					includeIgnored: {
						type: 'boolean',
						description: 'Include ignored files in the changed-file list. Defaults to false.'
					}
				},
				additionalProperties: false
			},
			async handler(args) {
				const { includeIgnored } = GitStatusArgs.parse(args);
				if (!(await isGitRepo(cwd))) {
					return JSON.stringify({ initialized: false, changes: [] }, null, 2);
				}
				const [head, entries] = await Promise.all([headInfo(cwd), status(cwd, { includeIgnored })]);
				return JSON.stringify(
					{
						initialized: true,
						head,
						changes: entries.map((e) => ({
							...e,
							status: aggregateStatus(e, { includeIgnored })
						}))
					},
					null,
					2
				);
			}
		},
		{
			name: 'git_diff',
			description:
				'Structured replacement for `git diff`. Returns a unified diff for worktree/index/commit comparisons, optionally limited to a workspace path.',
			parameters: {
				type: 'object',
				properties: {
					target: {
						type: 'string',
						enum: TargetKind.options,
						description: 'Diff target. Defaults to worktree-vs-head. Commit targets require sha.'
					},
					sha: {
						type: 'string',
						description: 'Commit SHA for target=commit or target=commit-vs-parent.'
					},
					path: {
						type: 'string',
						description: 'Optional workspace-relative path to limit the diff.'
					}
				},
				additionalProperties: false
			},
			async handler(args) {
				const parsed = GitDiffArgs.parse(args);
				const target = toDiffTarget(parsed.target, parsed.sha);
				const out = await diff(cwd, target, parsed.path);
				return out || '(no diff)';
			}
		},
		{
			name: 'git_log',
			description:
				'Structured replacement for `git log`. Returns recent commits with author, timestamp, and subject.',
			parameters: {
				type: 'object',
				properties: {
					limit: {
						type: 'number',
						description: 'Maximum commits to return, 1-50. Defaults to 20.'
					},
					skip: {
						type: 'number',
						description: 'Number of commits to skip. Defaults to 0.'
					},
					ref: {
						type: 'string',
						description: 'Optional ref to log, such as HEAD or a branch name.'
					}
				},
				additionalProperties: false
			},
			async handler(args) {
				const parsed = GitLogArgs.parse(args);
				const entries = await log(cwd, parsed);
				return JSON.stringify({ commits: entries }, null, 2);
			}
		},
		{
			name: 'git_show_commit',
			description:
				'Structured replacement for `git show <sha>` metadata. Returns commit details and changed files without executing arbitrary git shell arguments.',
			parameters: {
				type: 'object',
				properties: {
					sha: {
						type: 'string',
						description: 'Commit SHA to inspect.'
					}
				},
				required: ['sha'],
				additionalProperties: false
			},
			async handler(args) {
				const { sha } = GitShowCommitArgs.parse(args);
				const commit = await showCommit(cwd, sha);
				return JSON.stringify(commit, null, 2);
			}
		},
		{
			name: 'git_show_file',
			description:
				'Structured replacement for `git show <ref>:<path>`. Reads one workspace file at a Git ref.',
			parameters: {
				type: 'object',
				properties: {
					ref: {
						type: 'string',
						description: 'Git ref, branch, tag, or commit SHA.'
					},
					path: {
						type: 'string',
						description: 'Workspace-relative file path.'
					}
				},
				required: ['ref', 'path'],
				additionalProperties: false
			},
			async handler(args) {
				const { ref, path } = GitShowFileArgs.parse(args);
				return await showFile(cwd, ref, path);
			}
		}
	];
}

function toDiffTarget(kind: z.infer<typeof TargetKind>, sha: string | undefined): DiffTarget {
	switch (kind) {
		case 'worktree-vs-head':
		case 'worktree-vs-index':
		case 'index-vs-head':
			return { kind };
		case 'commit':
		case 'commit-vs-parent':
			if (!sha) throw new Error(`sha is required for git_diff target=${kind}`);
			return { kind, sha };
	}
}

function requiresSha(kind: z.infer<typeof TargetKind>): boolean {
	return kind === 'commit' || kind === 'commit-vs-parent';
}
