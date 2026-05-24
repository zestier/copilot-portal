#!/usr/bin/env node
// Starts `vite dev` against a throwaway DATA_DIR so exploratory testing
// (curl / Playwright / manual poking) never touches the real ./data
// database used by the live portal.
//
// Why this exists: with AUTH_MODE=none the app auto-creates a single
// "local-dev" user. If you point a dev server at the live ./data, any
// conversations you create during testing land in that user's sidebar
// — which is the same identity your real local portal session uses.
// Use this script for any throwaway dev work; use `pnpm dev` only when
// you specifically want to share state with the live portal.
//
// The temp dir is created fresh each run under the OS tmpdir and is
// NOT deleted on exit (so you can post-mortem it); they're small.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'zap-dev-'));
console.log(`[dev-isolated] DATA_DIR=${dataDir}`);
console.log('[dev-isolated] AUTH_MODE=none (local-only)');

const child = spawn('pnpm', ['exec', 'vite', 'dev', ...process.argv.slice(2)], {
	stdio: 'inherit',
	env: {
		...process.env,
		DATA_DIR: dataDir,
		AUTH_MODE: 'none',
		HOST: '127.0.0.1',
		I_KNOW_THIS_IS_LOCAL: '1'
		// SESSION_SECRET / ENCRYPTION_KEY are intentionally not set:
		// with AUTH_MODE=none the config schema treats them as optional
		// and the server uses a fixed local-dev key. Setting them would
		// trigger zod's `.min(32)` / base64-32B validators unnecessarily.
	}
});

const forward = (sig) => child.kill(sig);
process.on('SIGINT', forward);
process.on('SIGTERM', forward);
child.on('exit', (code, sig) => {
	if (sig) process.kill(process.pid, sig);
	else process.exit(code ?? 0);
});
