import { describe, it, expect, beforeEach } from 'vitest';
import {
	decideByPolicy,
	register,
	resolve,
	cancel,
	cancelConversation,
	newRequestId,
	get
} from '../src/lib/server/copilot/interactive-requests';
import * as users from '../src/lib/server/db/repos/users';
import * as convs from '../src/lib/server/db/repos/conversations';
import type {
	InteractiveKind,
	InteractiveResponse,
	InteractiveRequestView,
	PortalEvent
} from '../src/lib/types';
import { setupLocalEnv } from './helpers/env';

describe('decideByPolicy', () => {
	it('only auto-approves the permission kind', () => {
		// Non-permission kinds are user-facing decisions; never silently apply.
		expect(decideByPolicy('allow-all', 'auto_mode_switch')).toBe('ask');
		expect(decideByPolicy('allow-all', 'exit_plan_mode')).toBe('ask');
		expect(decideByPolicy('allow-all', 'user_input')).toBe('ask');
		expect(decideByPolicy('deny-all', 'elicitation')).toBe('ask');
	});
	it('permission kind respects the policy table', () => {
		expect(decideByPolicy('allow-all', 'permission', 'shell')).toBe('approved');
		expect(decideByPolicy('deny-all', 'permission', 'read')).toBe('denied');
		expect(decideByPolicy('prompt', 'permission', 'shell')).toBe('ask');
		expect(decideByPolicy('prompt', 'permission', 'read')).toBe('approved');
		expect(decideByPolicy('prompt', 'permission', 'url')).toBe('approved');
	});
});

describe('interactive request registry', () => {
	let userId: string;
	let conversationId: string;
	beforeEach(async () => {
		await setupLocalEnv('portal-interactive-test-');
		userId = users.ensureLocalUser().id;
		conversationId = convs.create(userId, { title: 't', workdir: '/tmp', model: null }).id;
	});

	function makePending(
		kind: InteractiveKind,
		view: InteractiveRequestView,
		emit: ((ev: PortalEvent) => void) | undefined
	) {
		const requestId = view.requestId;
		let resolved: InteractiveResponse | null = null;
		register({
			requestId,
			conversationId,
			kind,
			view,
			resolve: (r) => {
				resolved = r;
			},
			reject: () => {},
			emit,
			// Disable the default 10-minute timer so the test process can exit
			// cleanly without dangling timers.
			timeoutMs: 0
		});
		return { requestId, getResolved: () => resolved };
	}

	function permView(requestId: string): InteractiveRequestView {
		return {
			requestId,
			kind: 'permission',
			tool: 'shell',
			permissionKind: 'shell',
			summary: 'ls',
			args: null
		};
	}

	it('resolve emits interactive.resolved before unblocking the SDK', () => {
		const events: Array<PortalEvent & { _resolvedAtEmit?: unknown }> = [];
		const requestId = newRequestId();
		const { getResolved } = makePending('permission', permView(requestId), (ev) => {
			events.push({ ...ev, _resolvedAtEmit: getResolved() });
		});

		expect(resolve(requestId, userId, { kind: 'permission', decision: 'allow-once' })).toBe(true);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: 'interactive.resolved',
			requestId,
			kind: 'permission',
			outcome: { kind: 'permission', decision: 'allow-once' }
		});
		expect(events[0]._resolvedAtEmit).toBeNull();
		expect(getResolved()).toEqual({ kind: 'permission', decision: 'allow-once' });
		expect(get(requestId)).toBeUndefined();
		expect(resolve(requestId, userId, { kind: 'permission', decision: 'allow-once' })).toBe(false);
	});

	it('rejects a response whose kind does not match the pending request', () => {
		const events: PortalEvent[] = [];
		const requestId = newRequestId();
		const { getResolved } = makePending('permission', permView(requestId), (ev) => events.push(ev));

		const ok = resolve(requestId, userId, {
			kind: 'auto_mode_switch',
			decision: 'yes'
		});
		expect(ok).toBe(false);
		expect(events).toHaveLength(0);
		expect(getResolved()).toBeNull();
		expect(get(requestId)).toBeDefined();
	});

	it('cancel emits a kind-appropriate default denial', () => {
		const events: PortalEvent[] = [];
		const requestId = newRequestId();
		const view: InteractiveRequestView = {
			requestId,
			kind: 'auto_mode_switch',
			errorCode: 'rate_limited'
		};
		const { getResolved } = makePending('auto_mode_switch', view, (ev) => events.push(ev));
		cancel(requestId);
		expect(events[0]).toMatchObject({
			type: 'interactive.resolved',
			requestId,
			kind: 'auto_mode_switch',
			outcome: { kind: 'auto_mode_switch', decision: 'no' }
		});
		expect(getResolved()).toEqual({ kind: 'auto_mode_switch', decision: 'no' });
		expect(get(requestId)).toBeUndefined();
	});

	it('cancelConversation rejects every pending request for a conversation', () => {
		const a = newRequestId();
		const b = newRequestId();
		const aGet = makePending('permission', permView(a), undefined).getResolved;
		const bGet = makePending(
			'exit_plan_mode',
			{
				requestId: b,
				kind: 'exit_plan_mode',
				summary: 'go?',
				actions: ['execute'],
				recommendedAction: 'execute'
			},
			undefined
		).getResolved;
		cancelConversation(conversationId, 'turn_aborted');
		expect(aGet()).toEqual({ kind: 'permission', decision: 'deny' });
		expect(bGet()).toEqual({ kind: 'exit_plan_mode', approved: false });
		expect(get(a)).toBeUndefined();
		expect(get(b)).toBeUndefined();
	});

	it('an emit callback that throws does not break resolution', () => {
		const requestId = newRequestId();
		const { getResolved } = makePending('permission', permView(requestId), () => {
			throw new Error('boom');
		});
		expect(() =>
			resolve(requestId, userId, { kind: 'permission', decision: 'allow-once' })
		).not.toThrow();
		expect(getResolved()).toEqual({ kind: 'permission', decision: 'allow-once' });
	});

	it('allow-always installs a grant for the tool in the conversation', async () => {
		const settings = await import('../src/lib/server/db/repos/settings');
		const requestId = newRequestId();
		makePending('permission', permView(requestId), undefined);
		expect(settings.hasGrant(userId, conversationId, 'shell')).toBe(false);
		resolve(requestId, userId, { kind: 'permission', decision: 'allow-always' });
		expect(settings.hasGrant(userId, conversationId, 'shell')).toBe(true);
	});

	it('refuses to persist an allow-always grant when policy is deny-all', async () => {
		const settings = await import('../src/lib/server/db/repos/settings');
		settings.save(userId, {
			defaultModel: null,
			defaultWorkdir: null,
			defaultPolicy: 'deny-all',
			theme: 'dark'
		});
		const requestId = newRequestId();
		makePending('permission', permView(requestId), undefined);
		resolve(requestId, userId, { kind: 'permission', decision: 'allow-always' });
		expect(settings.hasGrant(userId, conversationId, 'shell')).toBe(false);
	});

	it('lists recent permission decisions for the user', async () => {
		const settings = await import('../src/lib/server/db/repos/settings');
		for (const decision of ['allow-once', 'deny', 'allow-always'] as const) {
			const requestId = newRequestId();
			makePending('permission', permView(requestId), undefined);
			resolve(requestId, userId, { kind: 'permission', decision });
		}
		const recent = settings.listRecentDecisionsForUser(userId, 10);
		expect(recent).toHaveLength(3);
		expect(recent[0].decision).toBe('allow-always');
		expect(recent[0].tool).toBe('shell');
		expect(recent[0].conversationId).toBe(conversationId);
	});

	it('matchGrant honors stored deny grants over allow grants', async () => {
		const settings = await import('../src/lib/server/db/repos/settings');
		settings.addGrant({
			userId,
			conversationId,
			tool: 'shell'
		});
		settings.addGrant({
			userId,
			conversationId,
			tool: 'shell',
			permissionKind: 'shell',
			scopePattern: 'rm *',
			decision: 'deny'
		});
		expect(settings.matchGrant(userId, conversationId, 'shell', 'shell', 'rm -rf /')).toBe('deny');
		expect(settings.matchGrant(userId, conversationId, 'shell', 'shell', 'ls -la')).toBe('allow');
	});

	it('matchGrant skips expired grants', async () => {
		const settings = await import('../src/lib/server/db/repos/settings');
		settings.addGrant({
			userId,
			conversationId,
			tool: 'shell',
			expiresAt: Date.now() - 1000
		});
		expect(settings.matchGrant(userId, conversationId, 'shell', 'shell', 'ls')).toBe('none');
	});

	it('user-global grants apply across conversations', async () => {
		const settings = await import('../src/lib/server/db/repos/settings');
		const convs = await import('../src/lib/server/db/repos/conversations');
		const other = convs.create(userId, { title: 'other', workdir: '/tmp', model: null }).id;
		settings.addGrant({ userId, conversationId: null, tool: 'shell' });
		expect(settings.matchGrant(userId, other, 'shell', 'shell', 'anything')).toBe('allow');
	});

	it('deny-always writes a deny grant and rejects future matching requests', async () => {
		const settings = await import('../src/lib/server/db/repos/settings');
		const requestId = newRequestId();
		makePending('permission', permView(requestId), undefined);
		resolve(requestId, userId, {
			kind: 'permission',
			decision: 'deny-always',
			scope: { permissionKind: 'shell', pattern: 'rm *' }
		});
		expect(settings.matchGrant(userId, conversationId, 'shell', 'shell', 'rm -rf /')).toBe('deny');
		// Unrelated commands still fall through.
		expect(settings.matchGrant(userId, conversationId, 'shell', 'shell', 'ls')).toBe('none');
	});

	it('allow-always with expiresInMs writes a TTL grant', async () => {
		const settings = await import('../src/lib/server/db/repos/settings');
		const requestId = newRequestId();
		makePending('permission', permView(requestId), undefined);
		resolve(requestId, userId, {
			kind: 'permission',
			decision: 'allow-always',
			expiresInMs: 60_000
		});
		expect(settings.matchGrant(userId, conversationId, 'shell', 'shell', 'ls')).toBe('allow');
		expect(
			settings.matchGrant(userId, conversationId, 'shell', 'shell', 'ls', Date.now() + 120_000)
		).toBe('none');
	});

	it('deny-always is allowed even when policy is deny-all', async () => {
		const settings = await import('../src/lib/server/db/repos/settings');
		settings.save(userId, {
			defaultModel: null,
			defaultWorkdir: null,
			defaultPolicy: 'deny-all',
			theme: 'dark'
		});
		const requestId = newRequestId();
		makePending('permission', permView(requestId), undefined);
		resolve(requestId, userId, {
			kind: 'permission',
			decision: 'deny-always'
		});
		// Recording a deny grant under deny-all is fine — it's never less safe.
		expect(settings.matchGrant(userId, conversationId, 'shell', 'shell', 'x')).toBe('deny');
	});
});
