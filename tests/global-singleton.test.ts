import { afterEach, describe, expect, it } from 'vitest';
import {
	appGlobalSymbols,
	clearGlobalSingletonValues,
	getGlobalSingletonValue,
	getOrCreateGlobalSingleton,
	setGlobalSingletonValue
} from '../src/lib/server/global-singleton';

const testedNames = ['db', 'pool.sessions', 'pool.inflight', 'pool.reaper', 'turns'];

function deleteKeys(name: string) {
	const globals = globalThis as unknown as Record<symbol, unknown>;
	for (const key of appGlobalSymbols(name)) {
		delete globals[key];
	}
}

describe('global singleton fallback keys', () => {
	afterEach(() => {
		for (const name of testedNames) deleteKeys(name);
	});

	it('keeps the current key first, followed by legacy app names in migration order', () => {
		expect(appGlobalSymbols('db')).toEqual([
			Symbol.for('zap.db'),
			Symbol.for('command-deck.db'),
			Symbol.for('agent-portal.db'),
			Symbol.for('copilot-portal.db')
		]);
	});

	it('resolves legacy fallback values instead of creating a new current singleton', () => {
		for (const name of testedNames) {
			for (const legacyKey of appGlobalSymbols(name).slice(1)) {
				deleteKeys(name);
				const legacyValue = { name, legacyKey };
				(globalThis as unknown as Record<symbol, unknown>)[legacyKey] = legacyValue;

				const resolved = getOrCreateGlobalSingleton(appGlobalSymbols(name), () => ({
					name,
					created: true
				}));

				expect(resolved).toBe(legacyValue);
				expect(getGlobalSingletonValue(appGlobalSymbols(name))).toBe(legacyValue);
			}
		}
	});

	it('creates new singletons only under the current app key', () => {
		const keys = appGlobalSymbols('db');
		const value = { db: true };

		expect(getOrCreateGlobalSingleton(keys, () => value)).toBe(value);
		expect((globalThis as unknown as Record<symbol, unknown>)[keys[0]]).toBe(value);
		for (const legacyKey of keys.slice(1)) {
			expect((globalThis as unknown as Record<symbol, unknown>)[legacyKey]).toBeUndefined();
		}
	});

	it('treats null current slots as cleared and continues checking legacy keys', () => {
		const keys = appGlobalSymbols('pool.reaper');
		const legacyValue = { timer: true };
		setGlobalSingletonValue(keys, null);
		(globalThis as unknown as Record<symbol, unknown>)[keys[1]] = legacyValue;

		expect(getGlobalSingletonValue(keys)).toBe(legacyValue);
	});

	it('can clear current and legacy slots after consuming a fallback singleton', () => {
		const keys = appGlobalSymbols('db');
		for (const key of keys) {
			(globalThis as unknown as Record<symbol, unknown>)[key] = { key };
		}

		clearGlobalSingletonValues(keys);

		expect(getGlobalSingletonValue(keys)).toBeNull();
		for (const key of keys) {
			expect((globalThis as unknown as Record<symbol, unknown>)[key]).toBeUndefined();
		}
	});
});
