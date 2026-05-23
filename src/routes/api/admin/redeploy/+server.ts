import { error } from '@sveltejs/kit';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { loadConfig } from '$lib/server/config';
import { log } from '$lib/server/log';
import { requireUserId } from '$lib/server/auth/require';
import { sseResponse } from '$lib/server/sse';

type Step = { label: string; cmd: string };

type RedeployEvent =
	| { type: 'step'; label: string; cmd: string }
	| { type: 'log'; stream: 'stdout' | 'stderr'; text: string }
	| { type: 'step-done'; label: string; code: number }
	| { type: 'done'; ok: true; restarting: true }
	| { type: 'done'; ok: false; failedStep?: string; code?: number; message?: string };

// `pnpm run verify` overlaps independent lint/check/unit phases, then runs
// one production build and Playwright e2e against that build. The supervisor
// (scripts/serve.mjs) runs the server out of its own `build.live/` copy and
// only refreshes it between restarts, so the build inside verify can overwrite
// `build/` freely without thrashing the chunks the live process is lazy-loading.
// On success we exit and the supervisor relaunches on the refreshed code; on
// failure (lint, type-check, unit tests, build, or e2e) the live tree is
// untouched.
const PULL_STEPS: Step[] = [
	{ label: 'git fetch', cmd: 'git fetch --all --prune' },
	{ label: 'git pull', cmd: 'git pull --ff-only' },
	{ label: 'pnpm install', cmd: 'pnpm install --frozen-lockfile' }
];
const BUILD_STEPS: Step[] = [{ label: 'pnpm run verify', cmd: 'pnpm run verify' }];

const Body = z.object({ pull: z.boolean().optional().default(true) });

let inFlight = false;

function runStep(label: string, cmd: string, emit: (ev: RedeployEvent) => void): Promise<number> {
	return new Promise<number>((resolve) => {
		emit({ type: 'step', label, cmd });
		const p = spawn('bash', ['-lc', cmd], { cwd: process.cwd(), env: process.env });
		p.stdout.on('data', (b: Buffer) => emit({ type: 'log', stream: 'stdout', text: b.toString() }));
		p.stderr.on('data', (b: Buffer) => emit({ type: 'log', stream: 'stderr', text: b.toString() }));
		p.on('error', (err) => {
			emit({ type: 'log', stream: 'stderr', text: `spawn error: ${err.message}\n` });
			resolve(1);
		});
		p.on('close', (code) => {
			emit({ type: 'step-done', label, code: code ?? 1 });
			resolve(code ?? 1);
		});
	});
}

async function* runRedeploy(steps: Step[]): AsyncGenerator<RedeployEvent> {
	const queue: RedeployEvent[] = [];
	let wake: (() => void) | null = null;
	const emit = (ev: RedeployEvent) => {
		queue.push(ev);
		wake?.();
	};

	try {
		let failedStep: string | undefined;
		let failedCode = 0;
		for (const { label, cmd } of steps) {
			const done = runStep(label, cmd, emit);
			// Drain emitted events as the step runs.
			let code: number | undefined;
			done.then((c) => {
				code = c;
				wake?.();
			});
			while (code === undefined || queue.length > 0) {
				if (queue.length === 0) {
					await new Promise<void>((r) => {
						wake = r;
					});
					wake = null;
					continue;
				}
				yield queue.shift()!;
			}
			if (code !== 0) {
				failedStep = label;
				failedCode = code;
				log.warn('redeploy.failed', { step: label, code });
				break;
			}
		}
		if (failedStep) {
			yield { type: 'done', ok: false, failedStep, code: failedCode };
		} else {
			yield { type: 'done', ok: true, restarting: true };
			log.info('redeploy.ok.exiting');
			// Let the supervisor relaunch us. Defer slightly so the SSE payload
			// reaches the client before the socket dies. If the supervisor isn't
			// running this is a no-op and the cleared inFlight flag below lets
			// future POSTs proceed.
			setTimeout(() => process.exit(0), 500).unref();
		}
	} catch (err) {
		log.error('redeploy.crash', { err: String(err) });
		yield { type: 'done', ok: false, message: String(err) };
	} finally {
		inFlight = false;
	}
}

export const POST: RequestHandler = async ({ request, locals }) => {
	const userId = requireUserId(locals);
	const cfg = loadConfig();
	if (!cfg.ENABLE_REDEPLOY) {
		throw error(403, 'Redeploy disabled. Set ENABLE_REDEPLOY=1 and run via `pnpm run serve`.');
	}
	if (inFlight) throw error(409, 'A redeploy is already in progress.');

	let pull = true;
	try {
		const text = await request.text();
		if (text) pull = Body.parse(JSON.parse(text)).pull;
	} catch {
		// Empty / non-JSON body: default to pull=true.
	}

	const steps: Step[] = pull ? [...PULL_STEPS, ...BUILD_STEPS] : BUILD_STEPS;
	inFlight = true;
	log.info('redeploy.start', { userId, pull });

	return sseResponse(runRedeploy(steps));
};
