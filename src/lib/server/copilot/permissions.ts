// Permission flow: bridges the SDK's `onPermissionRequest` callback to a
// deferred resolved by an HTTP endpoint. Decisions are persisted.

import { ulid } from 'ulid';
import * as settingsRepo from '../db/repos/settings';
import type { PermissionDecision, PermissionPolicy, PortalEvent } from '$lib/types';

export interface PendingPermission {
	requestId: string;
	conversationId: string;
	tool: string;
	kind: string;
	summary: string;
	args: unknown;
	resolve: (decision: PermissionDecision) => void;
	reject: (err: unknown) => void;
	createdAt: number;
	/**
	 * Broadcasts an event into the active turn's stream. Used to publish a
	 * `tool.permission.resolved` event so that any future re-subscriber (a
	 * page refresh, a visibility-driven reconnect, etc.) which replays the
	 * turn's event log learns that the request has already been decided and
	 * can clear the prompt. Without this, the original `tool.permission`
	 * event in the log would resurrect a dialog that was already answered.
	 */
	emit?: (ev: PortalEvent) => void;
}

// Per-process map. Acceptable for single-instance deployment.
const pending = new Map<string, PendingPermission>();

export function newRequestId(): string {
	return ulid();
}

export function register(p: PendingPermission) {
	pending.set(p.requestId, p);
}

export function resolve(requestId: string, userId: string, decision: PermissionDecision): boolean {
	const p = pending.get(requestId);
	if (!p) return false;
	pending.delete(requestId);

	// Record decision audit + grants.
	settingsRepo.recordDecision(
		p.conversationId,
		p.tool,
		typeof p.summary === 'string' ? p.summary : '',
		decision
	);
	if (decision === 'allow-always') {
		settingsRepo.addGrant(userId, p.conversationId, p.tool);
	}
	// Broadcast resolution BEFORE unblocking the SDK so the event lands
	// in the turn's event log before any subsequent tool.call/result.
	try {
		p.emit?.({ type: 'tool.permission.resolved', requestId: p.requestId, decision });
	} catch {
		/* non-fatal */
	}
	p.resolve(decision);
	return true;
}

export function cancel(requestId: string) {
	const p = pending.get(requestId);
	if (!p) return;
	pending.delete(requestId);
	try {
		p.emit?.({ type: 'tool.permission.resolved', requestId: p.requestId, decision: 'deny' });
	} catch {
		/* non-fatal */
	}
	p.resolve('deny');
}

export function get(requestId: string): PendingPermission | undefined {
	return pending.get(requestId);
}

// --- Policy helpers ---

const READ_ONLY_KINDS = new Set(['read', 'url']);

export function decideByPolicy(
	policy: PermissionPolicy,
	kind: string
): 'approved' | 'denied' | 'ask' {
	switch (policy) {
		case 'allow-all':
			return 'approved';
		case 'deny-all':
			return 'denied';
		case 'allow-readonly':
			return READ_ONLY_KINDS.has(kind) ? 'approved' : 'ask';
		case 'prompt':
		default:
			return READ_ONLY_KINDS.has(kind) ? 'approved' : 'ask';
	}
}
