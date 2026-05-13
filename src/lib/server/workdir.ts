// Resolve a workdir to an absolute path and enforce containment under the
// configured DATA_DIR or an explicit allowlist.

import { realpathSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from './config';

function allowedRoots(): string[] {
	const cfg = loadConfig();
	const roots = [resolve(cfg.DATA_DIR, 'workspaces')];
	// Future: ALLOWED_WORKDIRS env.
	return roots.map(realpathSafe);
}

function realpathSafe(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}

export function defaultWorkdirFor(conversationId: string): string {
	const cfg = loadConfig();
	const dir = resolve(cfg.DATA_DIR, 'workspaces', conversationId);
	mkdirSync(dir, { recursive: true });
	return realpathSafe(dir);
}

export function resolveAndValidate(
	input: string
): { ok: true; path: string } | { ok: false; reason: string } {
	const abs = resolve(input);
	if (!existsSync(abs)) {
		try {
			mkdirSync(abs, { recursive: true });
		} catch {
			return { ok: false, reason: 'workdir does not exist and could not be created' };
		}
	}
	const real = realpathSafe(abs);
	const roots = allowedRoots();
	if (!roots.some((root) => real === root || real.startsWith(root + '/'))) {
		return { ok: false, reason: `workdir not under allowed roots (${roots.join(', ')})` };
	}
	return { ok: true, path: real };
}

export { join as joinPath };
