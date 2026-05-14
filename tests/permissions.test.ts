import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	decideByPolicy,
	register,
	resolve,
	cancel,
	newRequestId,
	get
} from '../src/lib/server/copilot/permissions';
import { closeDb } from '../src/lib/server/db';
import { resetConfigForTests } from '../src/lib/server/config';
import * as users from '../src/lib/server/db/repos/users';
import * as convs from '../src/lib/server/db/repos/conversations';
import type { PermissionDecision, PortalEvent } from '../src/lib/types';

function setupTmpDataDir() {
	const dir = mkdtempSync(join(tmpdir(), 'portal-perm-test-'));
	process.env.DATA_DIR = dir;
	process.env.HOST = '127.0.0.1';
	process.env.AUTH_MODE = 'none';
	process.env.I_KNOW_THIS_IS_LOCAL = '1';
	delete process.env.SESSION_SECRET;
	resetConfigForTests();
	closeDb();
	return dir;
}

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

describe('resolve / cancel emit resolved event', () => {
	let userId: string;
	let conversationId: string;
	beforeEach(() => {
		setupTmpDataDir();
		userId = users.ensureLocalUser().id;
		conversationId = convs.create(userId, { title: 't', workdir: '/tmp', model: null }).id;
	});

	function makePending(emit: ((ev: PortalEvent) => void) | undefined) {
		const requestId = newRequestId();
		let resolved: PermissionDecision | null = null;
		register({
			requestId,
			conversationId,
			tool: 'shell',
			kind: 'shell',
			summary: 'ls',
			args: null,
			resolve: (d) => {
				resolved = d;
			},
			reject: () => {},
			createdAt: Date.now(),
			emit
		});
		return { requestId, getResolved: () => resolved };
	}

	it('resolve emits tool.permission.resolved before unblocking the SDK', () => {
		const events: PortalEvent[] = [];
		const { requestId, getResolved } = makePending((ev) => {
			// Capture order: emit must happen while the deferred is still
			// unresolved so the replay log sees `resolved` before any
			// subsequent tool.call/result events the SDK produces.
			events.push({ ...ev, _resolvedAtEmit: getResolved() } as PortalEvent & {
				_resolvedAtEmit: PermissionDecision | null;
			});
		});

		expect(resolve(requestId, userId, 'allow-once')).toBe(true);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: 'tool.permission.resolved',
			requestId,
			decision: 'allow-once'
		});
		expect((events[0] as unknown as { _resolvedAtEmit: unknown })._resolvedAtEmit).toBeNull();
		expect(getResolved()).toBe('allow-once');
		// Pending entry is removed so a stale POST is a no-op.
		expect(get(requestId)).toBeUndefined();
		expect(resolve(requestId, userId, 'allow-once')).toBe(false);
	});

	it('resolve carries allow-always through to the emitted event', () => {
		const events: PortalEvent[] = [];
		const { requestId } = makePending((ev) => events.push(ev));
		resolve(requestId, userId, 'allow-always');
		expect(events[0]).toMatchObject({ type: 'tool.permission.resolved', decision: 'allow-always' });
	});

	it('cancel emits a deny resolution', () => {
		const events: PortalEvent[] = [];
		const { requestId, getResolved } = makePending((ev) => events.push(ev));
		cancel(requestId);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: 'tool.permission.resolved',
			requestId,
			decision: 'deny'
		});
		expect(getResolved()).toBe('deny');
		expect(get(requestId)).toBeUndefined();
	});

	it('an emit callback that throws does not break resolution', () => {
		const { requestId, getResolved } = makePending(() => {
			throw new Error('boom');
		});
		expect(() => resolve(requestId, userId, 'allow-once')).not.toThrow();
		expect(getResolved()).toBe('allow-once');
	});

	it('a pending entry without emit still resolves cleanly', () => {
		const { requestId, getResolved } = makePending(undefined);
		expect(() => resolve(requestId, userId, 'deny')).not.toThrow();
		expect(getResolved()).toBe('deny');
	});
});
