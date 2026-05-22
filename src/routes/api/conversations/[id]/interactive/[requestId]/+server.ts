import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as interactive from '$lib/server/copilot/interactive-requests';
import { parseBody } from '$lib/server/validate';
import { authorizeConversation } from '$lib/server/conversation-auth';
import type { InteractiveResponse } from '$lib/types';

// Per-kind response schemas. The HTTP body must include `kind` so we can
// route to the right shape; the server-side registry then verifies the kind
// matches the pending request before applying any side effects.

// Structured FsScope wire shape mirrors `FsScope` in
// $lib/permissions/scope-types. Keep narrow: the dialog only emits
// `exact` and `prefix` (workspace / workspace-glob come from seeds, not
// dialog responses). Defense-in-depth: re-validate at the server-side
// codec layer too.
const FsRuleSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('exact'), path: z.string().min(1).max(4096) }),
	z.object({ kind: z.literal('prefix'), path: z.string().min(1).max(4096) })
]);

// Structured ShellScope wire shape mirrors `ShellScope` in
// $lib/permissions/scope-types. The shell picker only emits the
// argv0-anchored shapes (with optional subcommands and a coarse
// positionals rule); richer option rules come from
// Settings / seeds, not dialog responses. The shape is re-validated by
// the codec on the way to the DB.
const ShellRuleSchema = z.object({
	argv0: z
		.string()
		.min(1)
		.max(128)
		.refine((s) => !s.includes('/') && !s.startsWith('.'), {
			message: 'argv0 must be a bare command name'
		}),
	subcommands: z.array(z.string().min(1).max(128)).max(32).optional(),
	positionals: z
		.object({
			kind: z.enum(['none', 'any', 'workspace-paths'])
		})
		.optional()
});

const StructuredScopeSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('fs'),
		perms: z
			.array(z.enum(['read', 'write', 'edit']))
			.max(3)
			.optional(),
		rule: FsRuleSchema
	}),
	z.object({
		kind: z.literal('shell'),
		rule: ShellRuleSchema
	})
]);

const PermissionScope = z.object({
	permissionKind: z.string().min(1).max(64).nullable().optional(),
	pattern: z.string().max(1024).nullable().optional(),
	scope: StructuredScopeSchema.optional()
});

const PermissionBody = z.object({
	kind: z.literal('permission'),
	decision: z.enum(['allow-once', 'allow-always', 'deny', 'deny-always']),
	scope: PermissionScope.optional(),
	// Multi-grant payload. The shell picker may persist several
	// per-argv0 grants from one click; we cap the array to keep abuse
	// surface tiny. Each entry is validated as a full PermissionScope.
	additionalScopes: z.array(PermissionScope).max(16).optional(),
	applyToAllConversations: z.boolean().optional(),
	// Cap at 30 days to keep "time-limited" meaningful.
	expiresInMs: z
		.number()
		.int()
		.positive()
		.max(30 * 24 * 60 * 60 * 1000)
		.optional()
});

const AutoModeSwitchBody = z.object({
	kind: z.literal('auto_mode_switch'),
	decision: z.enum(['yes', 'no'])
});

const UserInputBody = z.object({
	kind: z.literal('user_input'),
	answer: z.string(),
	wasFreeform: z.boolean().optional()
});

const ElicitationContent = z.record(
	z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])
);

const ElicitationBody = z.object({
	kind: z.literal('elicitation'),
	action: z.enum(['accept', 'decline', 'cancel']),
	content: ElicitationContent.optional()
});

const ExitPlanModeBody = z.object({
	kind: z.literal('exit_plan_mode'),
	approved: z.boolean(),
	selectedAction: z.string().optional(),
	feedback: z.string().optional()
});

const InfoAckBody = z.object({
	kind: z.enum(['sampling', 'mcp_oauth', 'external_tool']),
	action: z.literal('ack')
});

const Body = z.discriminatedUnion('kind', [
	PermissionBody,
	AutoModeSwitchBody,
	UserInputBody,
	ElicitationBody,
	ExitPlanModeBody,
	InfoAckBody
]);

export const POST: RequestHandler = async ({ params, locals, request }) => {
	const conv = authorizeConversation(params.id, locals.userId);

	const body = (await parseBody(request, Body)) as InteractiveResponse;
	const pending = interactive.get(params.requestId!);
	if (!pending || pending.conversationId !== conv.id) throw error(404);

	const ok = interactive.resolve(params.requestId!, conv.userId, body);
	if (!ok) throw error(409, 'kind mismatch or already resolved');
	return json({ ok: true });
};
