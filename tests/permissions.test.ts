import { describe, it, expect } from 'vitest';
import { decideByPolicy } from '../src/lib/server/copilot/permissions';

describe('decideByPolicy', () => {
	it('allow-all approves everything', () => {
		expect(decideByPolicy('allow-all', 'shell')).toBe('approved');
		expect(decideByPolicy('allow-all', 'write')).toBe('approved');
	});
	it('deny-all denies everything', () => {
		expect(decideByPolicy('deny-all', 'read')).toBe('denied');
	});
	it('allow-readonly approves read/url, asks for the rest', () => {
		expect(decideByPolicy('allow-readonly', 'read')).toBe('approved');
		expect(decideByPolicy('allow-readonly', 'url')).toBe('approved');
		expect(decideByPolicy('allow-readonly', 'shell')).toBe('ask');
		expect(decideByPolicy('allow-readonly', 'write')).toBe('ask');
	});
	it('prompt asks unless read-only', () => {
		expect(decideByPolicy('prompt', 'shell')).toBe('ask');
		expect(decideByPolicy('prompt', 'read')).toBe('approved');
	});
});
