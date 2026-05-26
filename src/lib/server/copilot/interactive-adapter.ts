import type {
	ElicitationSchema,
	InteractiveKind,
	InteractiveRequestView,
	InteractiveRequestViewBody,
	InteractiveResponse,
	PermissionPolicy,
	PortalEvent,
	SessionMode
} from '$lib/types';
import {
	newRequestId,
	register as registerInteractive,
	decideByPolicy
} from './interactive-requests';
import * as settingsRepo from '../db/repos/settings';
import { deriveScopeKey } from '../permissions/matcher';
import {
	detectShellMisuse,
	parseShellCommand,
	type ParsedSegment
} from '../permissions/shell-parser';
import { log } from '../log';
import * as messagesRepo from '../db/repos/messages';
import { argsHash } from '../tool-invocation';

interface PermissionRequestLike {
	kind?: string;
	toolName?: string;
	toolCallId?: string;
	toolDescription?: string;
	fileName?: string;
	fullCommandText?: string;
	path?: string;
	url?: string;
	intention?: string;
	forcePermissionPrompt?: unknown;
	args?: unknown;
}

const FORCE_PERMISSION_PROMPT_MIN_LENGTH = 20;
const INVALID_FORCE_PERMISSION_PROMPT_FEEDBACK =
	'`forcePermissionPrompt` must be a reason string of at least 20 characters explaining why no allowed alternative works.';

interface InteractiveAdapterOptions {
	conversationId: string;
	userId: string;
	workingDirectory: string;
	policy: PermissionPolicy;
	emit(ev: PortalEvent): void;
	getApproveAll(): boolean;
	getMode(): SessionMode;
	getSessionWorkspacePath(): string | null;
	getPermissionBehavior(tool: string): 'normal' | 'always-prompt';
}

export function createInteractiveCallbacks(opts: InteractiveAdapterOptions) {
	async function askInteractive<R extends InteractiveResponse>(
		kind: InteractiveKind,
		view: InteractiveRequestViewBody
	): Promise<R> {
		const requestId = newRequestId();
		const full = { requestId, ...view } as InteractiveRequestView;
		return await new Promise<R>((resolve, reject) => {
			registerInteractive({
				requestId,
				conversationId: opts.conversationId,
				kind,
				view: full,
				resolve: (r) => resolve(r as R),
				reject,
				emit: opts.emit
			});
			opts.emit({ type: 'interactive.request', request: full });
		});
	}

	const onPermissionRequest = async (req: PermissionRequestLike) => {
		const tool = req.toolName ?? req.kind ?? 'unknown';
		const permissionKind = req.kind ?? 'unknown';
		const summary = summarizePermissionRequest(req, tool);
		const scopeKey = deriveScopeKey(permissionKind, req);
		const hash = hashPermissionArgs(req);
		const alwaysPrompt = opts.getPermissionBehavior(tool) === 'always-prompt';

		const audit = (decision: 'auto-allow' | 'auto-deny' | 'auto-prompt-required') => {
			try {
				settingsRepo.recordDecision(opts.conversationId, tool, summary, decision);
			} catch (e) {
				log.warn('copilot.permission_audit_failed', {
					conversationId: opts.conversationId,
					err: String(e)
				});
			}
		};

		const forcePermissionPrompt = parseForcePermissionPrompt(req);
		if (forcePermissionPrompt.kind === 'invalid') {
			audit('auto-deny');
			return { kind: 'reject', feedback: forcePermissionPrompt.feedback } as const;
		}
		const forceEscalationReason =
			forcePermissionPrompt.kind === 'valid' ? forcePermissionPrompt.reason : null;

		let shellSegments: ParsedSegment[] | null = null;
		let shellAnalysis: import('$lib/types').ShellAnalysisView | undefined = undefined;
		if (permissionKind === 'shell' && typeof scopeKey === 'string') {
			const misuse = detectShellMisuse(scopeKey);
			if (misuse) {
				audit('auto-deny');
				return { kind: 'reject', feedback: misuse.feedback } as const;
			}
			const parsed = parseShellCommand(scopeKey);
			if (parsed.kind === 'parsed') {
				shellSegments = parsed.segments;
				shellAnalysis = {
					kind: 'parsed',
					segments: parsed.segments.map((s) => ({
						argv: s.argv,
						followingOp: s.followingOp
					}))
				};
			} else {
				shellAnalysis = { kind: 'unsafe', reason: parsed.reason };
			}
		}

		const maybePromptForEscalation = async (
			fallbackFeedback = 'Escalation denied. Use an allowed alternative or stop and explain what capability is missing.'
		) => {
			if (!forceEscalationReason) return null;
			const response = await askInteractive<Extract<InteractiveResponse, { kind: 'permission' }>>(
				'permission',
				{
					kind: 'permission',
					tool,
					permissionKind,
					summary,
					args: req.args ?? null,
					userPolicy: opts.policy,
					canPersistDecision: false,
					escalationReason: forceEscalationReason,
					shellAnalysis
				}
			);
			if (response.decision === 'deny' || response.decision === 'deny-always') {
				audit('auto-deny');
				return rejectWithFeedback(response, fallbackFeedback);
			}
			audit('auto-allow');
			return { kind: 'approve-once' } as const;
		};

		if (alwaysPrompt) {
			const response = await askInteractive<Extract<InteractiveResponse, { kind: 'permission' }>>(
				'permission',
				{
					kind: 'permission',
					tool,
					permissionKind,
					summary,
					args: req.args ?? null,
					userPolicy: opts.policy,
					canPersistDecision: false,
					shellAnalysis
				}
			);
			if (response.decision === 'deny' || response.decision === 'deny-always') {
				return rejectWithFeedback(response);
			}
			audit('auto-allow');
			return { kind: 'approve-once' } as const;
		}
		const target =
			permissionKind === 'read' || permissionKind === 'write' || permissionKind === 'edit'
				? scopeKey
				: null;
		const url = permissionKind === 'url' ? scopeKey : null;

		const grant = settingsRepo.matchGrantDetailed(
			opts.userId,
			opts.conversationId,
			tool,
			permissionKind,
			scopeKey,
			{
				shellSegments,
				target,
				url,
				workspaceRoot: opts.workingDirectory ?? null,
				sessionWorkspaceRoot: opts.getSessionWorkspacePath(),
				argsHash: hash
			}
		);
		if (grant.outcome === 'allow') {
			audit('auto-allow');
			return { kind: 'approve-once' } as const;
		}
		if (grant.outcome === 'deny') {
			audit('auto-deny');
			if (grant.feedback) return { kind: 'reject', feedback: grant.feedback } as const;
			return { kind: 'reject' } as const;
		}
		let promptRequest: { canPersistDecision: boolean; bestEffortFeedback: string };
		if (grant.outcome === 'prompt') {
			promptRequest = {
				canPersistDecision: false,
				bestEffortFeedback: grant.feedback ?? bestEffortPromptGrantFeedback({ permissionKind })
			};
		} else {
			if (opts.getApproveAll()) {
				audit('auto-allow');
				return { kind: 'approve-once' } as const;
			}

			const decision = decideByPolicy(opts.policy, 'permission', permissionKind, {
				scopeKey,
				workspaceRoot: opts.workingDirectory
			});
			if (decision === 'approved') {
				audit('auto-allow');
				return { kind: 'approve-once' } as const;
			}
			if (decision === 'denied') {
				audit('auto-deny');
				return { kind: 'reject' } as const;
			}
			promptRequest = {
				canPersistDecision: true,
				bestEffortFeedback: bestEffortPermissionFeedback({ permissionKind })
			};
		}

		if (opts.getMode() === 'best-effort') {
			const escalated = await maybePromptForEscalation();
			if (escalated) return escalated;
			audit('auto-prompt-required');
			return {
				kind: 'reject',
				feedback: promptRequest.bestEffortFeedback
			} as const;
		}

		const response = await askInteractive<Extract<InteractiveResponse, { kind: 'permission' }>>(
			'permission',
			{
				kind: 'permission',
				tool,
				permissionKind,
				summary,
				args: req.args ?? null,
				userPolicy: opts.policy,
				canPersistDecision: promptRequest.canPersistDecision,
				shellAnalysis
			}
		);
		if (response.decision === 'deny' || response.decision === 'deny-always') {
			return rejectWithFeedback(response);
		}
		return { kind: 'approve-once' } as const;
	};

	const onUserInputRequest = async (req: {
		question?: string;
		choices?: string[];
		allowFreeform?: boolean;
	}) => {
		const response = await askInteractive<Extract<InteractiveResponse, { kind: 'user_input' }>>(
			'user_input',
			{
				kind: 'user_input',
				question: req.question ?? 'The agent is requesting input.',
				choices: req.choices,
				allowFreeform: req.allowFreeform ?? true
			}
		);
		return { answer: response.answer, wasFreeform: response.wasFreeform ?? true };
	};

	const onElicitationRequest = async (ctx: {
		message?: string;
		requestedSchema?: unknown;
		mode?: 'form' | 'url';
		url?: string;
		elicitationSource?: string;
	}) => {
		const response = await askInteractive<Extract<InteractiveResponse, { kind: 'elicitation' }>>(
			'elicitation',
			{
				kind: 'elicitation',
				message: ctx.message ?? '',
				mode: ctx.mode ?? 'form',
				url: ctx.url,
				requestedSchema: ctx.requestedSchema as ElicitationSchema | undefined,
				elicitationSource: ctx.elicitationSource
			}
		);
		if (response.action === 'accept') {
			return { action: 'accept' as const, content: response.content ?? {} };
		}
		return { action: response.action };
	};

	const onExitPlanMode = async (req: {
		summary?: string;
		planContent?: string;
		actions?: string[];
		recommendedAction?: string;
	}) => {
		const actions = req.actions ?? ['continue'];
		const response = await askInteractive<Extract<InteractiveResponse, { kind: 'exit_plan_mode' }>>(
			'exit_plan_mode',
			{
				kind: 'exit_plan_mode',
				summary: req.summary ?? 'Exit plan mode and continue?',
				planContent: req.planContent,
				actions,
				recommendedAction: req.recommendedAction ?? actions[0] ?? 'continue'
			}
		);
		return {
			approved: response.approved,
			selectedAction: response.selectedAction,
			feedback: response.feedback
		};
	};

	const onAutoModeSwitch = async (req: { errorCode?: string; retryAfterSeconds?: number }) => {
		const response = await askInteractive<
			Extract<InteractiveResponse, { kind: 'auto_mode_switch' }>
		>('auto_mode_switch', {
			kind: 'auto_mode_switch',
			errorCode: req.errorCode,
			retryAfterSeconds: req.retryAfterSeconds
		});
		return response.decision;
	};

	return {
		onPermissionRequest,
		onUserInputRequest,
		onElicitationRequest,
		onExitPlanMode,
		onAutoModeSwitch
	};
}

function rejectWithFeedback(
	response: Extract<InteractiveResponse, { kind: 'permission' }>,
	fallbackFeedback?: string
) {
	const feedback = response.feedback?.trim() || fallbackFeedback;
	return feedback ? ({ kind: 'reject', feedback } as const) : ({ kind: 'reject' } as const);
}

function hashPermissionArgs(req: PermissionRequestLike): string | null {
	if (typeof req.toolCallId === 'string') {
		const args = messagesRepo.getToolCallArgs(req.toolCallId);
		if (args !== null) return argsHash(args);
	}
	if (req.args !== undefined) return argsHash(req.args);
	return null;
}

function parseForcePermissionPrompt(
	req: PermissionRequestLike
): { kind: 'absent' } | { kind: 'invalid'; feedback: string } | { kind: 'valid'; reason: string } {
	const values = forcePermissionPromptValues(req);
	if (values.length === 0) return { kind: 'absent' };

	let reason: string | null = null;
	for (const value of values) {
		if (typeof value !== 'string') {
			return { kind: 'invalid', feedback: INVALID_FORCE_PERMISSION_PROMPT_FEEDBACK };
		}
		const trimmed = value.trim();
		if (trimmed.length < FORCE_PERMISSION_PROMPT_MIN_LENGTH) {
			return { kind: 'invalid', feedback: INVALID_FORCE_PERMISSION_PROMPT_FEEDBACK };
		}
		reason ??= trimmed;
	}

	return { kind: 'valid', reason: reason ?? '' };
}

function forcePermissionPromptValues(req: PermissionRequestLike): unknown[] {
	const values: unknown[] = [];
	if (hasOwn(req, 'forcePermissionPrompt')) values.push(req.forcePermissionPrompt);

	const argValue = readArgValue(req.args, 'forcePermissionPrompt');
	if (argValue.present) values.push(argValue.value);

	if (typeof req.toolCallId === 'string') {
		const persistedValue = readArgValue(
			messagesRepo.getToolCallArgs(req.toolCallId),
			'forcePermissionPrompt'
		);
		if (persistedValue.present) values.push(persistedValue.value);
	}

	return values;
}

function readArgValue(
	args: unknown,
	key: string
): { present: false } | { present: true; value: unknown } {
	if (!args || typeof args !== 'object') return { present: false };
	if (!hasOwn(args, key)) return { present: false };
	return { present: true, value: (args as Record<string, unknown>)[key] };
}

function hasOwn(obj: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

function bestEffortPermissionFeedback(view: { permissionKind: string }): string {
	const alternative = bestEffortAlternativeHint(view.permissionKind);
	const permissionKind = bestEffortPermissionKindLabel(view.permissionKind);
	return (
		`A ${permissionKind} permission request was auto-rejected because this conversation is in \`best-effort\` mode. ` +
		`${alternative} Use \`permission_capabilities\` to inspect alternatives. If still blocked after verifying no allowed alternative works, retry sparingly with \`forcePermissionPrompt\`.`
	);
}

function bestEffortPromptGrantFeedback(view: { permissionKind: string }): string {
	const permissionKind = bestEffortPermissionKindLabel(view.permissionKind);
	return (
		`A ${permissionKind} permission request matched a saved prompt grant and ` +
		'requires interactive approval, ' +
		'but this conversation is in `best-effort` mode and cannot display permission dialogs.'
	);
}

function bestEffortPermissionKindLabel(permissionKind: string): string {
	switch (permissionKind) {
		case 'shell':
		case 'read':
		case 'write':
		case 'edit':
		case 'url':
			return permissionKind;
		default:
			return 'unknown';
	}
}

function bestEffortAlternativeHint(permissionKind: string): string {
	switch (permissionKind) {
		case 'shell':
			return 'Try a structured tool or another already-allowed approach first.';
		case 'read':
			return 'Try the structured read/search tools or existing workspace context first.';
		case 'write':
		case 'edit':
			return 'Try a structured workspace edit/create workflow or another already-allowed path first.';
		case 'url':
			return (
				'Try a local source or another non-network approach first. ' +
				'If the answer depends on external documentation, current API behavior, or other version-specific online information, retry with `forcePermissionPrompt` instead of guessing.'
			);
		default:
			return 'Try another approach that stays within the current permission set first.';
	}
}

function summarizePermissionRequest(req: PermissionRequestLike, tool: string): string {
	if (
		tool === 'git_commit' &&
		req.args &&
		typeof req.args === 'object' &&
		!Array.isArray(req.args)
	) {
		const args = req.args as Record<string, unknown>;
		const subject = typeof args.subject === 'string' && args.subject ? args.subject : 'commit';
		const paths = args.paths;
		const lines = ['Create Git commit', `Subject: ${subject}`];
		if (paths === 'all') {
			lines.push('Target: all current workspace changes');
		} else if (Array.isArray(paths)) {
			lines.push(`Target: ${paths.length} selected ${paths.length === 1 ? 'path' : 'paths'}`);
			for (const path of paths.slice(0, 10)) lines.push(`- ${String(path)}`);
			if (paths.length > 10) lines.push(`- ...and ${paths.length - 10} more`);
		} else {
			lines.push('Target: selected paths');
		}
		if (typeof args.body === 'string' && args.body.length > 0) {
			const lineCount = args.body.split(/\r\n|\r|\n/).length;
			lines.push(`Body: ${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`);
		}
		const trailers = Array.isArray(args.trailers) ? args.trailers : [];
		if (trailers.length > 0) {
			const tokens = trailers
				.map((trailer) =>
					trailer && typeof trailer === 'object'
						? String((trailer as Record<string, unknown>).token ?? '')
						: ''
				)
				.filter(Boolean);
			lines.push(
				`Trailers: ${trailers.length}${tokens.length ? ` (${tokens.slice(0, 5).join(', ')}${tokens.length > 5 ? ', ...' : ''})` : ''}`
			);
		}
		lines.push('Approval: one-time only; stored grants are disabled for git_commit.');
		return lines.join('\n');
	}
	return req.fullCommandText ?? req.fileName ?? req.path ?? req.url ?? req.toolDescription ?? tool;
}
