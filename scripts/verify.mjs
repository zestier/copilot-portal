#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const args = new Set(process.argv.slice(2));
const sequential = args.has('--sequential');
const failureProbe = args.has('--failure-probe');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const taskDefinitions = {
	lint: { label: 'lint', command: pnpm, args: ['lint'] },
	check: { label: 'check', command: pnpm, args: ['check'] },
	unit: { label: 'unit', command: pnpm, args: ['test'] },
	build: { label: 'build', command: pnpm, args: ['build'] },
	e2e: { label: 'e2e', command: pnpm, args: ['test:e2e:run'] }
};

const plannedGroups = sequential
	? [
			[taskDefinitions.lint],
			[taskDefinitions.check],
			[taskDefinitions.unit],
			[taskDefinitions.build],
			[taskDefinitions.e2e]
		]
	: [
			[taskDefinitions.lint, taskDefinitions.check, taskDefinitions.unit],
			[taskDefinitions.build],
			[taskDefinitions.e2e]
		];

const groups = failureProbe
	? [[{ label: 'failure-probe', command: process.execPath, args: ['-e', 'process.exit(7)'] }]]
	: plannedGroups;

function formatCommand(task) {
	return [task.command, ...task.args].join(' ');
}

function formatDuration(ms) {
	const seconds = ms / 1000;
	return seconds >= 60
		? `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`
		: `${seconds.toFixed(1)}s`;
}

function pipeWithPrefix(stream, label, write) {
	let pending = '';
	stream.on('data', (chunk) => {
		pending += chunk.toString();
		const lines = pending.split(/\r?\n/);
		pending = lines.pop() ?? '';
		for (const line of lines) write(`[${label}] ${line}\n`);
	});
	stream.on('end', () => {
		if (pending) write(`[${label}] ${pending}\n`);
	});
}

function runTask(task) {
	return new Promise((resolve) => {
		const start = performance.now();
		console.log(`[verify] start ${task.label}: ${formatCommand(task)}`);
		const child = spawn(task.command, task.args, {
			cwd: process.cwd(),
			env: process.env,
			stdio: ['ignore', 'pipe', 'pipe']
		});

		pipeWithPrefix(child.stdout, task.label, (text) => process.stdout.write(text));
		pipeWithPrefix(child.stderr, task.label, (text) => process.stderr.write(text));

		child.on('error', (err) => {
			const durationMs = performance.now() - start;
			console.error(
				`[verify] ${task.label} spawn failed after ${formatDuration(durationMs)}: ${err.message}`
			);
			resolve({ task, code: 1, durationMs });
		});
		child.on('close', (code, signal) => {
			const durationMs = performance.now() - start;
			const exitCode = code ?? 1;
			const status = signal ? `signal ${signal}` : `exit ${exitCode}`;
			const marker = exitCode === 0 ? 'ok' : 'failed';
			console.log(
				`[verify] ${marker} ${task.label}: ${status} after ${formatDuration(durationMs)}`
			);
			resolve({ task, code: exitCode, durationMs });
		});
	});
}

const startedAt = performance.now();
const failures = [];
const allResults = [];

console.log(
	`[verify] mode: ${failureProbe ? 'failure probe' : sequential ? 'sequential benchmark' : 'parallel'}`
);

for (const group of groups) {
	if (group.length > 1) {
		console.log(`[verify] parallel group: ${group.map((task) => task.label).join(', ')}`);
	}
	const results = await Promise.all(group.map(runTask));
	allResults.push(...results);
	failures.push(...results.filter((result) => result.code !== 0));
	if (failures.length > 0) break;
}

const totalMs = performance.now() - startedAt;
console.log('[verify] summary:');
for (const result of allResults) {
	console.log(
		`[verify]   ${result.task.label.padEnd(13)} ${formatDuration(result.durationMs).padStart(8)} exit ${
			result.code
		}`
	);
}
console.log(`[verify] total ${formatDuration(totalMs)}`);

if (failures.length > 0) {
	console.error(
		`[verify] failed: ${failures
			.map((result) => `${result.task.label} (exit ${result.code})`)
			.join(', ')}`
	);
	process.exit(1);
}
