import { z } from 'zod';
import type { PermissionPolicy, SessionMode } from '$lib/types';
import type { GrantScope } from '$lib/permissions/scope-types';
import * as settings from '../db/repos/settings';
import type { PortalTool } from './git';

const PermissionKind = z.enum(['shell', 'read', 'write', 'edit', 'url', 'custom-tool']);

const CapabilitiesArgs = z
	.object({
		permissionKind: PermissionKind.optional(),
		toolName: z.string().trim().min(1).max(200).optional(),
		intent: z.string().trim().min(1).max(500).optional()
	})
	.optional()
	.default({});

type CapabilityStatus = 'allowed' | 'denied' | 'prompt_required' | 'partially_allowed';

interface CapabilityRule {
	kind: 'tool' | 'filesystem' | 'shell' | 'url' | 'legacy' | 'exact-invocation' | 'policy';
	decision: 'allow' | 'deny';
	scope: 'all-conversations' | 'current-conversation';
	summary: string;
}

interface Capability {
	permissionKind: string;
	status: CapabilityStatus;
	guidance: string;
	allowed?: CapabilityRule[];
	denied?: CapabilityRule[];
}

export function buildPermissionTools(opts: {
	userId: string;
	conversationId: string;
	policy: PermissionPolicy;
	getMode: () => SessionMode;
}): PortalTool[] {
	return [
		{
			name: 'permission_capabilities',
			description:
				'Read-only summary of currently allowed permission capabilities and recovery options. Use after a permission rejection to find allowed alternatives before escalating.',
			parameters: {
				type: 'object',
				properties: {
					permissionKind: {
						type: 'string',
						enum: PermissionKind.options,
						description: 'Optional permission kind to inspect.'
					},
					toolName: {
						type: 'string',
						description: 'Optional tool name to inspect, such as shell, git_status, or view.'
					},
					intent: {
						type: 'string',
						description: 'Optional short description of what you were trying to do.'
					}
				},
				additionalProperties: false
			},
			async handler(args) {
				const parsed = CapabilitiesArgs.parse(args);
				return JSON.stringify(
					permissionCapabilities({
						userId: opts.userId,
						conversationId: opts.conversationId,
						mode: opts.getMode(),
						policy: opts.policy,
						permissionKind: parsed.permissionKind,
						toolName: parsed.toolName,
						intent: parsed.intent
					}),
					null,
					2
				);
			}
		}
	];
}

function permissionCapabilities(opts: {
	userId: string;
	conversationId: string;
	mode: SessionMode;
	policy: PermissionPolicy;
	permissionKind?: string;
	toolName?: string;
	intent?: string;
}) {
	const grants = settings
		.listGrantsForUser(opts.userId)
		.filter((g) => g.conversationId === null || g.conversationId === opts.conversationId)
		.filter((g) => !g.expiresAt || g.expiresAt >= Date.now())
		.filter((g) => !opts.toolName || g.tool === opts.toolName || g.tool === '*')
		.filter((g) => !opts.permissionKind || grantCoversPermissionKind(g, opts.permissionKind));

	const kinds = opts.permissionKind
		? [opts.permissionKind]
		: opts.toolName
			? ['shell', 'read', 'write', 'edit', 'url', 'custom-tool']
			: ['shell', 'read', 'write', 'edit', 'url'];
	const capabilities = kinds.map((permissionKind) =>
		capabilityForKind(permissionKind, grants, opts.policy)
	);

	return {
		mode: opts.mode,
		policy: opts.policy,
		bestEffort: opts.mode === 'best-effort',
		filters: {
			permissionKind: opts.permissionKind ?? null,
			toolName: opts.toolName ?? null,
			intent: opts.intent ?? null
		},
		capabilities,
		escalation: {
			forcePermissionPrompt: {
				supported: true,
				guidance:
					'Always available. Retry the blocked request with forcePermissionPrompt and a concise reason when no allowed alternative works.'
			}
		}
	};
}

function capabilityForKind(
	permissionKind: string,
	grants: settings.GrantSummary[],
	policy: PermissionPolicy
): Capability {
	const relevant = grants.filter((g) => grantCoversPermissionKind(g, permissionKind));
	const allowed = relevant.filter((g) => g.decision === 'allow').map(grantToRule);
	const denied = relevant.filter((g) => g.decision === 'deny').map(grantToRule);
	const policyRule = policyRuleFor(permissionKind, policy);
	if (policyRule?.decision === 'allow') allowed.push(policyRule);
	if (policyRule?.decision === 'deny') denied.push(policyRule);

	const status = capabilityStatus(allowed, denied, policy);
	return pruneEmptyArrays({
		permissionKind,
		status,
		guidance: guidanceFor(permissionKind, status),
		allowed,
		denied
	});
}

function capabilityStatus(
	allowed: CapabilityRule[],
	denied: CapabilityRule[],
	policy: PermissionPolicy
): CapabilityStatus {
	if (allowed.length > 0 && denied.length > 0) return 'partially_allowed';
	if (allowed.length > 0) return 'allowed';
	if (denied.length > 0 || policy === 'deny-all') return 'denied';
	return 'prompt_required';
}

function grantCoversPermissionKind(g: settings.GrantSummary, permissionKind: string): boolean {
	if (
		g.permissionKind === permissionKind ||
		g.permissionKind === '*' ||
		g.permissionKind === null
	) {
		return true;
	}
	if (permissionKind === 'custom-tool' && g.permissionKind === 'custom-tool') return true;
	if (g.scope?.kind === 'fs' && ['read', 'write', 'edit'].includes(permissionKind)) {
		return !g.scope.perms || g.scope.perms.includes(permissionKind as 'read' | 'write' | 'edit');
	}
	return g.scope?.kind === permissionKind;
}

function grantToRule(g: settings.GrantSummary): CapabilityRule {
	return {
		kind: ruleKind(g),
		decision: g.decision,
		scope: g.conversationId === null ? 'all-conversations' : 'current-conversation',
		summary: grantSummary(g)
	};
}

function ruleKind(g: settings.GrantSummary): CapabilityRule['kind'] {
	if (g.argsHash) return 'exact-invocation';
	if (!g.scope) return 'legacy';
	switch (g.scope.kind) {
		case 'any':
			return 'tool';
		case 'fs':
			return 'filesystem';
		case 'shell':
			return 'shell';
		case 'url':
			return 'url';
	}
}

function grantSummary(g: settings.GrantSummary): string {
	if (g.argsHash) return `${decisionVerb(g)} a previously approved exact ${g.tool} invocation.`;
	if (!g.scope) return `${decisionVerb(g)} ${g.tool} requests covered by a legacy grant.`;
	return `${decisionVerb(g)} ${g.tool} for ${scopeSummary(g.scope)}.`;
}

function decisionVerb(g: settings.GrantSummary): 'Allow' | 'Deny' {
	return g.decision === 'deny' ? 'Deny' : 'Allow';
}

function scopeSummary(scope: GrantScope): string {
	switch (scope.kind) {
		case 'any':
			return 'any request to this tool';
		case 'shell':
			return shellRuleSummary(scope.rule);
		case 'fs':
			return fsScopeSummary(scope);
		case 'url':
			return urlRuleSummary(scope.rule);
	}
}

function shellRuleSummary(rule: Extract<GrantScope, { kind: 'shell' }>['rule']): string {
	const parts = [`shell command \`${rule.argv0}\``];
	if (rule.subcommands?.length) parts.push(`subcommands: ${rule.subcommands.join(', ')}`);
	if (rule.positionals) parts.push(`positionals: ${rule.positionals.kind}`);
	if (rule.pipeline) parts.push(`pipeline: ${rule.pipeline}`);
	return parts.join('; ');
}

function fsScopeSummary(scope: Extract<GrantScope, { kind: 'fs' }>): string {
	const perms = scope.perms?.length ? scope.perms.join('/') : 'read/write/edit';
	const rule = scope.rule;
	if (rule.behavior === 'any') return `${perms} anywhere under ${rule.root}`;
	if (rule.root === 'absolute') return `${perms} for a specific absolute ${rule.behavior} rule`;
	return `${perms} for a ${rule.behavior} rule under ${rule.root}`;
}

function urlRuleSummary(rule: Extract<GrantScope, { kind: 'url' }>['rule']): string {
	switch (rule.kind) {
		case 'exact':
			return 'a specific URL';
		case 'host':
			return `URLs on host ${rule.host}`;
		case 'host-suffix':
			return `URLs on hosts ending in ${rule.suffix}`;
	}
}

function policyRuleFor(permissionKind: string, policy: PermissionPolicy): CapabilityRule | null {
	if (policy === 'prompt') return null;
	return {
		kind: 'policy',
		decision: policy === 'allow-all' ? 'allow' : 'deny',
		scope: 'current-conversation',
		summary: `${policy} policy applies to ${permissionKind} requests not covered by grants.`
	};
}

function guidanceFor(permissionKind: string, status: CapabilityStatus): string {
	if (status === 'allowed')
		return `${permissionKind} has allowed paths available; prefer those first.`;
	if (status === 'partially_allowed') {
		return `${permissionKind} has both allow and deny rules; use the allowed alternatives and avoid denied shapes.`;
	}
	if (status === 'denied') {
		return `${permissionKind} is currently denied by policy or grants; use escalation if no other kind works.`;
	}
	return (
		`${permissionKind} requests not covered by listed grants will prompt. ` +
		'In best-effort mode, prompt-worthy requests auto-reject.'
	);
}

function pruneEmptyArrays(capability: Capability): Capability {
	if (capability.allowed?.length === 0) delete capability.allowed;
	if (capability.denied?.length === 0) delete capability.denied;
	return capability;
}
