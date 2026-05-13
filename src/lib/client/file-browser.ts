// Shared client-side types for the file browser.

export type FileBrowserStatus =
	| 'untracked'
	| 'ignored'
	| 'modified'
	| 'added'
	| 'deleted'
	| 'renamed'
	| 'conflicted';

export interface FsEntry {
	name: string;
	relPath: string;
	type: 'file' | 'directory' | 'symlink' | 'other';
	size: number | null;
	mtimeMs: number | null;
	status: FileBrowserStatus | null;
	containsChanges: FileBrowserStatus | null;
}

export interface TreeResponse {
	path: string;
	entries: FsEntry[];
	git: { initialized: boolean };
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
export type HeadStatus = HeadInfo | { initialized: false };

export interface LogEntry {
	sha: string;
	shortSha: string;
	author: string;
	email: string;
	timestamp: number;
	subject: string;
}

export interface CommitFile {
	status: FileBrowserStatus;
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

export interface FileResponseText {
	binary: false;
	path: string;
	content: string;
	size: number;
	truncated: boolean;
	ref?: string;
}
export interface FileResponseBinary {
	binary: true;
	path: string;
	size?: number;
	ref?: string;
}
export type FileResponse = FileResponseText | FileResponseBinary;

export const STATUS_LABEL: Record<FileBrowserStatus, string> = {
	untracked: 'U',
	ignored: 'I',
	modified: 'M',
	added: 'A',
	deleted: 'D',
	renamed: 'R',
	conflicted: '!'
};

export const STATUS_COLOR: Record<FileBrowserStatus, string> = {
	untracked: 'var(--success)',
	ignored: 'var(--text-muted)',
	modified: 'var(--warning)',
	added: 'var(--success)',
	deleted: 'var(--danger)',
	renamed: 'var(--accent)',
	conflicted: 'var(--danger)'
};
