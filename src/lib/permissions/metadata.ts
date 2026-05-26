import { FS_PERMISSIONS, type FsPermission, type GrantScope } from './scope-types';

export const GRANT_TOOLS = ['shell', 'read', 'write', 'edit', 'url'] as const;
export type GrantTool = (typeof GRANT_TOOLS)[number];
export type GrantScopeKind = Exclude<GrantScope['kind'], 'any'>;

export interface PermissionScopeKeyRequest {
	fullCommandText?: string;
	fileName?: string;
	path?: string;
	url?: string;
	args?: unknown;
}

interface PermissionKindDescriptor {
	scopeKind: GrantScopeKind;
	label: string;
	grantFormLabel: string;
	bestEffortAlternativeHint: string;
	scopeKey(req: PermissionScopeKeyRequest): string | null;
}

const permissionKindDescriptors = {
	shell: {
		scopeKind: 'shell',
		label: 'shell',
		grantFormLabel: 'shell (run a command)',
		bestEffortAlternativeHint: 'Try a structured tool or another already-allowed approach first.',
		scopeKey: (req) => req.fullCommandText ?? readArgString(req.args, 'command') ?? null
	},
	read: {
		scopeKind: 'fs',
		label: 'read',
		grantFormLabel: 'read (file read)',
		bestEffortAlternativeHint:
			'Try the structured read/search tools or existing workspace context first.',
		scopeKey: (req) => req.path ?? req.fileName ?? readArgString(req.args, 'path') ?? null
	},
	write: {
		scopeKind: 'fs',
		label: 'write',
		grantFormLabel: 'write (file write)',
		bestEffortAlternativeHint:
			'Try a structured workspace edit/create workflow or another already-allowed path first.',
		scopeKey: fsWriteScopeKey
	},
	edit: {
		scopeKind: 'fs',
		label: 'edit',
		grantFormLabel: 'edit (file edit)',
		bestEffortAlternativeHint:
			'Try a structured workspace edit/create workflow or another already-allowed path first.',
		scopeKey: fsWriteScopeKey
	},
	url: {
		scopeKind: 'url',
		label: 'url',
		grantFormLabel: 'url (fetch URL)',
		bestEffortAlternativeHint:
			'Try a local source or another non-network approach first. If the answer depends on external documentation, current API behavior, or other version-specific online information, retry with `forcePermissionPrompt` instead of guessing.',
		scopeKey: (req) =>
			req.url ??
			readArgString(req.args, 'url') ??
			readArgString(req.args, 'href') ??
			req.fullCommandText ??
			null
	}
} satisfies Record<GrantTool, PermissionKindDescriptor>;

const fsPermissionKindSet = new Set<string>(FS_PERMISSIONS);
const grantToolSet = new Set<string>(GRANT_TOOLS);

export function isGrantTool(tool: string): tool is GrantTool {
	return grantToolSet.has(tool);
}

export function isFilesystemPermissionKind(kind: string): kind is FsPermission {
	return fsPermissionKindSet.has(kind);
}

export function expectedScopeKind(tool: GrantTool): GrantScopeKind {
	return permissionKindDescriptors[tool].scopeKind;
}

export function permissionKindForTool(tool: GrantTool): string {
	return tool;
}

export function derivePermissionScopeKey(
	permissionKind: string,
	req: PermissionScopeKeyRequest
): string | null {
	return isGrantTool(permissionKind)
		? permissionKindDescriptors[permissionKind].scopeKey(req)
		: null;
}

export function bestEffortPermissionKindLabel(permissionKind: string): string {
	return isGrantTool(permissionKind) ? permissionKindDescriptors[permissionKind].label : 'unknown';
}

export function bestEffortAlternativeHint(permissionKind: string): string {
	return isGrantTool(permissionKind)
		? permissionKindDescriptors[permissionKind].bestEffortAlternativeHint
		: 'Try another approach that stays within the current permission set first.';
}

export function grantToolLabel(tool: GrantTool): string {
	return permissionKindDescriptors[tool].grantFormLabel;
}

function fsWriteScopeKey(req: PermissionScopeKeyRequest): string | null {
	return req.fileName ?? req.path ?? readArgString(req.args, 'path') ?? null;
}

function readArgString(args: unknown, key: string): string | null {
	if (!args || typeof args !== 'object') return null;
	const v = (args as Record<string, unknown>)[key];
	return typeof v === 'string' && v.length > 0 ? v : null;
}
