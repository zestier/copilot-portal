import { describe, it, expect } from 'vitest';
import { resolveInitialSidebarOpen } from '../src/lib/client/sidebar';

describe('resolveInitialSidebarOpen', () => {
	it('honors a persisted "true" value regardless of viewport', () => {
		expect(resolveInitialSidebarOpen({ getStored: () => 'true', isDesktop: () => false })).toBe(
			true
		);
	});

	it('honors a persisted "false" value regardless of viewport', () => {
		expect(resolveInitialSidebarOpen({ getStored: () => 'false', isDesktop: () => true })).toBe(
			false
		);
	});

	it('defaults to open on desktop when nothing is persisted', () => {
		expect(resolveInitialSidebarOpen({ getStored: () => null, isDesktop: () => true })).toBe(true);
	});

	it('defaults to closed on mobile when nothing is persisted', () => {
		expect(resolveInitialSidebarOpen({ getStored: () => null, isDesktop: () => false })).toBe(
			false
		);
	});

	it('treats unrecognized stored values as missing', () => {
		expect(resolveInitialSidebarOpen({ getStored: () => 'garbage', isDesktop: () => false })).toBe(
			false
		);
		expect(resolveInitialSidebarOpen({ getStored: () => '', isDesktop: () => true })).toBe(true);
	});
});
