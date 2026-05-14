import { error } from '@sveltejs/kit';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { loadConfig } from '$lib/server/config';
import { log } from '$lib/server/log';
import { requireUserId } from '$lib/server/auth/require';

type Step = { label: string; cmd: string };

// `pnpm run verify` (the last build step) ends with `pnpm run test:e2e`,
// which in turn runs `pnpm run build`. The supervisor (scripts/serve.mjs)
// runs the server out of its own `build.live/` copy and only refreshes it
// between restarts, so the build inside verify can overwrite `build/`
// freely without thrashing the chunks the live process is lazy-loading.
// On success we exit and the supervisor relaunches on the refreshed code;
// on failure (lint, type-check, unit tests, build, or e2e) the live tree
// is untouched.
const PULL_STEPS: Step[] = [
	{ label: 'git fetch', cmd: 'git fetch --all --prune' },
	{ label: 'git pull', cmd: 'git pull --ff-only' },
	{ label: 'pnpm install', cmd: 'pnpm install --frozen-lockfile' }
];
const BUILD_STEPS: Step[] = [{ label: 'pnpm run verify', cmd: 'pnpm run verify' }];

const Body = z.object({ pull: z.boolean().optional().default(true) });

let inFlight = false;

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

	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			let closed = false;
			const send = (data: unknown) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
				} catch {
					closed = true;
				}
			};
			const close = () => {
				if (closed) return;
				closed = true;
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			};

			const runStep = (label: string, cmd: string) =>
				new Promise<number>((resolve) => {
					send({ type: 'step', label, cmd });
					const p = spawn('bash', ['-lc', cmd], {
						cwd: process.cwd(),
						env: process.env
					});
					p.stdout.on('data', (b: Buffer) =>
						send({ type: 'log', stream: 'stdout', text: b.toString() })
					);
					p.stderr.on('data', (b: Buffer) =>
						send({ type: 'log', stream: 'stderr', text: b.toString() })
					);
					p.on('error', (err) => {
						send({ type: 'log', stream: 'stderr', text: `spawn error: ${err.message}\n` });
						resolve(1);
					});
					p.on('close', (code) => {
						send({ type: 'step-done', label, code: code ?? 1 });
						resolve(code ?? 1);
					});
				});

			try {
				let failedStep: string | undefined;
				let failedCode = 0;
				for (const { label, cmd } of steps) {
					const code = await runStep(label, cmd);
					if (code !== 0) {
						failedStep = label;
						failedCode = code;
						log.warn('redeploy.failed', { step: label, code });
						break;
					}
				}
				if (failedStep) {
					send({ type: 'done', ok: false, failedStep, code: failedCode });
				} else {
					send({ type: 'done', ok: true, restarting: true });
					log.info('redeploy.ok.exiting');
					// Let the supervisor relaunch us. Defer slightly so the SSE
					// payload reaches the client before the socket dies. If the
					// supervisor isn't running this is a no-op and the cleared
					// inFlight flag below lets future POSTs proceed.
					setTimeout(() => process.exit(0), 500).unref();
				}
			} catch (err) {
				log.error('redeploy.crash', { err: String(err) });
				send({ type: 'done', ok: false, message: String(err) });
			} finally {
				close();
				inFlight = false;
			}
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			'x-accel-buffering': 'no'
		}
	});
};
