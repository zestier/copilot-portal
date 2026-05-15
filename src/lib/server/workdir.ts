// Resolve a conversation's workdir to an absolute path.
//
// The "workdir" is the directory the Copilot SDK runs against (its
// `workingDirectory`) — i.e. the real project tree the agent reads and
// edits. Earlier versions of the portal kept a private, per-conversation
// directory under `DATA_DIR/workspaces/<id>/` and tried to snapshot it
// per turn, but the SDK was never actually pointed at those dirs — the
// agent inherited the server's cwd instead, so every snapshot was of an
// empty tree and the fork-into-a-new-workdir machinery was unreachable
// in practice. We now just route everything to the configured
// PROJECT_ROOT (env or cwd), with an optional per-user override.

import { existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { loadConfig } from './config';

/**
 * The default workdir for newly created conversations when the user has
 * not set a per-user override and no explicit value is supplied at
 * creation time.
 */
export function projectRoot(): string {
	return resolve(loadConfig().PROJECT_ROOT);
}

/**
 * Translate a value stored in `conversations.workdir` into the path we
 * actually hand to the SDK and snapshotter. Falls back to PROJECT_ROOT
 * when:
 *  - the stored value is empty, or
 *  - it points into the legacy `<DATA_DIR>/workspaces/` tree (old, empty
 *    per-conversation sandboxes from before workdirs were wired through
 *    to the SDK; their on-disk dirs are still there but unusable).
 */
export function effectiveWorkdir(stored: string | null | undefined): string {
	if (!stored) return projectRoot();
	const abs = resolve(stored);
	const legacy = resolve(loadConfig().DATA_DIR, 'workspaces');
	if (abs === legacy || abs.startsWith(legacy + sep)) return projectRoot();
	return abs;
}

/**
 * Validate a user-supplied workdir path. The path must exist and be a
 * directory; no allowlist is enforced (the portal is a single-trusted-
 * user app — see AGENTS.md / auth-and-security docs).
 */
export function resolveAndValidate(
	input: string
): { ok: true; path: string } | { ok: false; reason: string } {
	const abs = resolve(input);
	if (!existsSync(abs)) {
		return { ok: false, reason: 'workdir does not exist' };
	}
	try {
		if (!statSync(abs).isDirectory()) {
			return { ok: false, reason: 'workdir is not a directory' };
		}
	} catch (e) {
		return { ok: false, reason: `workdir not accessible: ${(e as Error).message}` };
	}
	return { ok: true, path: abs };
}
