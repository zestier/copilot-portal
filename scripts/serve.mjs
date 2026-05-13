#!/usr/bin/env node
// Tiny supervisor: runs `node build` and respawns it whenever it exits.
//
// Use this instead of `node build` directly so the in-app "redeploy" button
// can rebuild and then exit(0) to roll itself over onto the new code, without
// needing systemd / pm2 / docker.
//
//   pnpm run build          # one-time, or done by redeploy
//   pnpm run serve          # long-running, like `pnpm run dev`
//
// Honors SIGINT/SIGTERM (forwarded to child) for clean Ctrl-C shutdown.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const entry = resolve(root, 'build', 'index.js');

let child = null;
let stopping = false;
let restartTimer = null;

function log(...args) {
	console.log('[serve]', ...args);
}

function start() {
	if (stopping) return;
	if (!existsSync(entry)) {
		log(`build/ missing at ${entry} — run \`pnpm run build\` first.`);
		process.exit(1);
	}
	log('starting node build');
	child = spawn(process.execPath, ['build'], {
		stdio: 'inherit',
		cwd: root,
		env: process.env
	});
	child.on('exit', (code, signal) => {
		log(`child exited code=${code} signal=${signal}`);
		child = null;
		if (stopping) return;
		// Brief backoff so a crash loop doesn't peg the CPU.
		const delay = code === 0 ? 250 : 2000;
		restartTimer = setTimeout(start, delay);
	});
}

function shutdown(sig) {
	if (stopping) return;
	stopping = true;
	log(`received ${sig}, shutting down`);
	if (restartTimer) clearTimeout(restartTimer);
	if (child) {
		child.kill(sig);
		// Hard exit if the child doesn't go away.
		setTimeout(() => process.exit(0), 5000).unref();
	} else {
		process.exit(0);
	}
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
