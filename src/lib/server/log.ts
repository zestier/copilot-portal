// Tiny structured logger. Outputs JSON lines to stdout.

import { loadConfig } from './config';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): Level {
	try {
		return loadConfig().LOG_LEVEL;
	} catch {
		return 'info';
	}
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
	if (ORDER[level] < ORDER[currentLevel()]) return;
	const line = { ts: new Date().toISOString(), level, msg, ...(fields ?? {}) };
	const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
	out.write(JSON.stringify(line) + '\n');
}

export const log = {
	debug: (msg: string, f?: Record<string, unknown>) => emit('debug', msg, f),
	info: (msg: string, f?: Record<string, unknown>) => emit('info', msg, f),
	warn: (msg: string, f?: Record<string, unknown>) => emit('warn', msg, f),
	error: (msg: string, f?: Record<string, unknown>) => emit('error', msg, f)
};
