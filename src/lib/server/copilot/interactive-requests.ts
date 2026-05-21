// Generic interactive-request registry.
//
// Bridges the SDK's interactive callbacks (onPermissionRequest,
// onAutoModeSwitch, onUserInputRequest, onElicitationRequest,
// onExitPlanMode) and information-only events (sampling.requested,
// mcp_oauth.required, external_tool.requested) to deferreds resolved by an
// HTTP endpoint. The flow is:
//
//   1. Bridge handler creates a deferred, calls register({...}), and emits
//      an `interactive.request` PortalEvent into the turn's stream.
//   2. UI sees the event, renders a dialog, and POSTs the user's response
//      to `/api/conversations/:id/interactive/:requestId`.
//   3. The endpoint calls resolve(requestId, ...). We emit an
//      `interactive.resolved` PortalEvent (so replayed event logs don't
//      resurrect a dialog that was already answered), record any side
//      effects (e.g. permission grants), and unblock the bridge.
//
// Cancellation: if the turn is aborted, the runner calls
// cancelConversation(conversationId) to reject all pending requests for
// that conversation so the SDK stops waiting.
//
// Timeout: each pending request has a server-side timeout (default 10 min)
// so a forgotten dialog doesn't pin the session forever.

import { ulid } from 'ulid';
import * as settingsRepo from '../db/repos/settings';
import { log } from '../log';
import type {
	InteractiveKind,
	InteractiveRequestView,
	InteractiveResponse,
	PermissionDecision,
	PermissionPolicy,
	PortalEvent
} from '$lib/types';

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export interface PendingInteractive {
	requestId: string;
	conversationId: string;
	kind: InteractiveKind;
	view: InteractiveRequestView;
	resolve: (response: InteractiveResponse) => void;
	reject: (err: unknown) => void;
	createdAt: number;
	/**
	 * Broadcasts an event into the active turn's stream. Used to publish an
	 * `interactive.resolved` event so that any future re-subscriber (a page
	 * refresh, a visibility-driven reconnect, etc.) which replays the turn's
	 * event log learns that the request has already been decided and can
	 * clear the prompt. Without this, the original `interactive.request`
	 * event in the log would resurrect a dialog that was already answered.
	 */
	emit?: (ev: PortalEvent) => void;
	timeoutHandle?: ReturnType<typeof setTimeout>;
}

// Per-process map. Acceptable for single-instance deployment.
const pending = new Map<string, PendingInteractive>();

export function newRequestId(): string {
	return ulid();
}

export interface RegisterOptions {
	requestId: string;
	conversationId: string;
	kind: InteractiveKind;
	view: InteractiveRequestView;
	resolve: (response: InteractiveResponse) => void;
	reject: (err: unknown) => void;
	emit?: (ev: PortalEvent) => void;
	timeoutMs?: number;
}

export function register(opts: RegisterOptions) {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const entry: PendingInteractive = {
		requestId: opts.requestId,
		conversationId: opts.conversationId,
		kind: opts.kind,
		view: opts.view,
		resolve: opts.resolve,
		reject: opts.reject,
		emit: opts.emit,
		createdAt: Date.now()
	};
	if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
		const t = setTimeout(() => {
			log.warn('interactive.timeout', {
				requestId: opts.requestId,
				kind: opts.kind,
				timeoutMs
			});
			cancel(opts.requestId, 'timeout');
		}, timeoutMs);
		(t as { unref?: () => void }).unref?.();
		entry.timeoutHandle = t;
	}
	pending.set(opts.requestId, entry);
	log.info('interactive.registered', { requestId: opts.requestId, kind: opts.kind });
}

export function get(requestId: string): PendingInteractive | undefined {
	return pending.get(requestId);
}

/**
 * Resolve a pending request with the given response. Returns true if the
 * request existed and was resolved. The response shape must match the
 * registered kind; mismatched responses are rejected with `kind_mismatch`.
 */
export function resolve(requestId: string, userId: string, response: InteractiveResponse): boolean {
	const p = pending.get(requestId);
	if (!p) return false;
	if (p.kind !== response.kind) {
		log.warn('interactive.kind_mismatch', {
			requestId,
			expected: p.kind,
			got: response.kind
		});
		return false;
	}
	pending.delete(requestId);
	if (p.timeoutHandle) clearTimeout(p.timeoutHandle);

	// Permission-specific bookkeeping: audit + grants.
	if (response.kind === 'permission' && p.view.kind === 'permission') {
		try {
			settingsRepo.recordDecision(
				p.conversationId,
				p.view.tool,
				typeof p.view.summary === 'string' ? p.view.summary : '',
				response.decision
			);
			if (response.decision === 'allow-always') {
				settingsRepo.addGrant(userId, p.conversationId, p.view.tool);
			}
		} catch (e) {
			log.warn('interactive.permission_persist_failed', { requestId, err: String(e) });
		}
	}

	// Broadcast resolution BEFORE unblocking the SDK so the event lands in
	// the turn's event log before any subsequent tool.call/result.
	try {
		p.emit?.({
			type: 'interactive.resolved',
			requestId: p.requestId,
			kind: p.kind,
			outcome: response
		});
	} catch {
		/* non-fatal */
	}

	log.info('interactive.resolved', { requestId, kind: p.kind });
	p.resolve(response);
	return true;
}

/**
 * Cancel a pending request, defaulting to a "deny / decline" response
 * appropriate for the kind. Used when the turn is aborted or times out.
 */
export function cancel(requestId: string, reason: string = 'cancelled') {
	const p = pending.get(requestId);
	if (!p) return;
	pending.delete(requestId);
	if (p.timeoutHandle) clearTimeout(p.timeoutHandle);

	const fallback = defaultDenial(p.kind);
	try {
		p.emit?.({
			type: 'interactive.resolved',
			requestId: p.requestId,
			kind: p.kind,
			outcome: fallback
		});
	} catch {
		/* non-fatal */
	}
	log.info('interactive.cancelled', { requestId, kind: p.kind, reason });
	p.resolve(fallback);
}

/**
 * Cancel every pending request for a conversation. Called from the turn
 * runner when a turn is aborted so the SDK doesn't hang waiting on
 * deferreds we've abandoned.
 */
export function cancelConversation(conversationId: string, reason: string = 'turn_aborted') {
	for (const [id, p] of pending) {
		if (p.conversationId === conversationId) cancel(id, reason);
	}
}

function defaultDenial(kind: InteractiveKind): InteractiveResponse {
	switch (kind) {
		case 'permission':
			return { kind: 'permission', decision: 'deny' };
		case 'auto_mode_switch':
			return { kind: 'auto_mode_switch', decision: 'no' };
		case 'user_input':
			return { kind: 'user_input', answer: '', wasFreeform: true };
		case 'elicitation':
			return { kind: 'elicitation', action: 'cancel' };
		case 'exit_plan_mode':
			return { kind: 'exit_plan_mode', approved: false };
		case 'sampling':
			return { kind: 'sampling', action: 'ack' };
		case 'mcp_oauth':
			return { kind: 'mcp_oauth', action: 'ack' };
		case 'external_tool':
			return { kind: 'external_tool', action: 'ack' };
	}
}

// --- Policy helpers ---
//
// Auto-approval is currently scoped to permission requests (the only kind
// the legacy policy applied to). Other kinds always 'ask' — auto-mode-switch
// in particular is a billing / quota decision that should never be silently
// approved.

const READ_ONLY_PERMISSION_KINDS = new Set(['read', 'url']);

export function decideByPolicy(
	policy: PermissionPolicy,
	kind: InteractiveKind,
	permissionKind?: string
): 'approved' | 'denied' | 'ask' {
	if (kind !== 'permission') return 'ask';
	const pk = permissionKind ?? '';
	switch (policy) {
		case 'allow-all':
			return 'approved';
		case 'deny-all':
			return 'denied';
		case 'allow-readonly':
			return READ_ONLY_PERMISSION_KINDS.has(pk) ? 'approved' : 'ask';
		case 'prompt':
		default:
			return READ_ONLY_PERMISSION_KINDS.has(pk) ? 'approved' : 'ask';
	}
}

/** @deprecated kept for legacy callers — prefer the InteractiveResponse path. */
export function permissionDecisionFromPolicy(
	policy: PermissionPolicy,
	permissionKind: string
): 'approved' | 'denied' | 'ask' {
	return decideByPolicy(policy, 'permission', permissionKind);
}

// Re-export so existing imports keep working through the rename.
export type { PermissionDecision };
