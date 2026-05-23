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

interface InteractiveAdapterOptions {
	conversationId: string;
	userId: string;
	workingDirectory: string;
	policy: PermissionPolicy;
	emit(ev: PortalEvent): void;
	getApproveAll(): boolean;
	getMode(): SessionMode;
	getSessionWorkspacePath(): string | null;
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
		const isModeSwitchToolRequest =
			permissionKind === 'custom-tool' && req.toolName === 'request_mode_switch';

		const audit = (decision: 'auto-allow' | 'auto-deny') => {
			try {
				settingsRepo.recordDecision(opts.conversationId, tool, summary, decision);
			} catch (e) {
				log.warn('copilot.permission_audit_failed', {
					conversationId: opts.conversationId,
					err: String(e)
				});
			}
		};

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

		if (opts.getApproveAll()) {
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
				sessionWorkspaceRoot: opts.getSessionWorkspacePath()
			}
		);
		if (grant.outcome === 'allow') {
			audit('auto-allow');
			return { kind: 'approve-once' } as const;
		}
		if (grant.outcome === 'deny') {
			const escalationReason = grant.denyReason ? readForcePermissionPrompt(req) : null;
			if (escalationReason) {
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
						escalationReason,
						shellAnalysis
					}
				);
				if (response.decision === 'deny' || response.decision === 'deny-always') {
					audit('auto-deny');
					return {
						kind: 'reject',
						feedback:
							'Escalation denied. Use structured tools or stop and explain what capability is missing.'
					} as const;
				}
				audit('auto-allow');
				return { kind: 'approve-once' } as const;
			}
			audit('auto-deny');
			if (grant.denyReason) return { kind: 'reject', feedback: grant.denyReason } as const;
			return { kind: 'reject' } as const;
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
		if (opts.getMode() === 'best-effort' && !isModeSwitchToolRequest) {
			audit('auto-deny');
			return {
				kind: 'reject',
				feedback: bestEffortPermissionFeedback({
					tool,
					permissionKind,
					summary,
					args: req.args ?? null,
					shellAnalysis
				})
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
				canPersistDecision: !isModeSwitchToolRequest,
				shellAnalysis
			}
		);
		if (response.decision === 'deny' || response.decision === 'deny-always')
			return { kind: 'reject' } as const;
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

function readForcePermissionPrompt(req: PermissionRequestLike): string | null {
	const raw =
		typeof req.forcePermissionPrompt === 'string'
			? req.forcePermissionPrompt
			: (readArgString(req.args, 'forcePermissionPrompt') ??
				(typeof req.toolCallId === 'string'
					? readArgString(messagesRepo.getToolCallArgs(req.toolCallId), 'forcePermissionPrompt')
					: null));
	const reason = raw?.trim();
	if (!reason) return null;
	if (reason.length < 20) return null;
	return reason;
}

function readArgString(args: unknown, key: string): string | null {
	if (!args || typeof args !== 'object') return null;
	const v = (args as Record<string, unknown>)[key];
	return typeof v === 'string' && v.length > 0 ? v : null;
}

function bestEffortPermissionFeedback(view: {
	tool: string;
	permissionKind: string;
	summary: string;
	args: unknown;
	shellAnalysis?: import('$lib/types').ShellAnalysisView;
}): string {
	const promptText = permissionPromptText(view);
	const alternative = bestEffortAlternativeHint(view.permissionKind);
	return (
		'This conversation is in `best-effort` mode, so permission prompts are auto-rejected instead of shown to the user. ' +
		`The user would have been asked to approve:\n\n${promptText}\n\n${alternative} If no workable alternative exists, stop and explain which permission is missing.`
	);
}

function permissionPromptText(view: {
	tool: string;
	permissionKind: string;
	summary: string;
	args: unknown;
	shellAnalysis?: import('$lib/types').ShellAnalysisView;
}): string {
	const lines = [`${view.tool} (${view.permissionKind})`, view.summary];
	if (view.permissionKind === 'shell' && view.shellAnalysis?.kind === 'unsafe') {
		lines.push(
			`Reason: ${view.shellAnalysis.reason}. Constructs like subshells, redirection, command substitution, or variable expansion can hide arbitrary commands, so structured "always" grants won't apply here.`
		);
	}
	return lines.join('\n');
}

function bestEffortAlternativeHint(permissionKind: string): string {
	switch (permissionKind) {
		case 'shell':
			return 'Try a structured tool or another already-allowed approach first. If you end up blocked on permissions, call `request_mode_switch` to ask the user to switch this conversation to interactive mode.';
		case 'read':
			return 'Try the structured read/search tools or existing workspace context first. If you end up blocked on permissions, call `request_mode_switch` to ask the user to switch this conversation to interactive mode.';
		case 'write':
		case 'edit':
			return 'Try a structured workspace edit/create workflow or another already-allowed path first. If you end up blocked on permissions, call `request_mode_switch` to ask the user to switch this conversation to interactive mode.';
		case 'url':
			return 'Try a local source or another non-network approach first. If you end up blocked on permissions, call `request_mode_switch` to ask the user to switch this conversation to interactive mode.';
		default:
			return 'Try another approach that stays within the current permission set first. If you end up blocked on permissions, call `request_mode_switch` to ask the user to switch this conversation to interactive mode.';
	}
}

function summarizePermissionRequest(req: PermissionRequestLike, tool: string): string {
	return req.fullCommandText ?? req.fileName ?? req.path ?? req.url ?? req.toolDescription ?? tool;
}
