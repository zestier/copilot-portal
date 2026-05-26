import { describe, expect, test } from 'vitest';
import { render } from 'svelte/server';
import Chat from '../src/lib/components/Chat.svelte';
import DiffView from '../src/lib/components/DiffView.svelte';
import FileBrowser from '../src/lib/components/FileBrowser.svelte';
import InteractiveRequestDialog from '../src/lib/components/InteractiveRequestDialog.svelte';
import { MAX_RENDERABLE_DIFF_CHARS } from '../src/lib/client/diff-parser';
import type {
	Conversation,
	InteractiveRequestView,
	ProviderCapabilities,
	ProviderRuntimeFeature,
	ProviderRuntimeFeatureStatus
} from '../src/lib/types';

const feature = (
	label: string,
	description: string,
	supported = true
): ProviderRuntimeFeatureStatus => ({
	supported,
	behavior: supported ? 'supported' : 'unsupported',
	label,
	description
});

const providerCapabilities: ProviderCapabilities = {
	authStatus: true,
	modelList: true,
	session: { open: true, resume: true, dispose: true, abort: true },
	stream: { send: true, contract: 'PortalEvent' },
	controls: {
		mode: true,
		approveAll: true,
		resetSessionApprovals: true
	},
	features: {
		modes: feature('Modes', 'Runtime mode changes are supported.'),
		approveAll: feature('Approve all', 'The runtime accepts approve-all toggles.'),
		contextUsage: feature('Context usage', 'Context usage is available.'),
		subagents: feature('Subagents', 'Subagents are available.'),
		mcpInfoEvents: feature('MCP info events', 'MCP info events are available.'),
		planExit: feature('Plan exit', 'Plan exit is available.'),
		elicitation: feature('Elicitation', 'Elicitation is available.')
	} satisfies Record<ProviderRuntimeFeature, ProviderRuntimeFeatureStatus>,
	optionalRuntimeFeatures: {
		infiniteSessionMetadata: true,
		permissionCallbacks: true,
		userInputCallbacks: true,
		elicitationCallbacks: true,
		exitPlanModeCallbacks: true,
		autoModeSwitchCallbacks: true,
		contextWindowEvents: true,
		contextCompactionEvents: true,
		fileEditEvents: true,
		reasoningEvents: true,
		subagentLifecycleEvents: true
	}
};

const conversation: Conversation = {
	id: 'conv-1',
	userId: 'user-1',
	title: 'Regression chat',
	workdir: '/workspaces/copilot-portal',
	provider: 'copilot',
	model: 'gpt-5.5',
	mode: 'best-effort',
	approveAllTools: false,
	createdAt: 1_700_000_000_000,
	updatedAt: 1_700_000_000_000,
	archivedAt: null,
	forkedFromConversationId: null,
	forkedFromMessageId: null,
	providerSessionId: 'session-1'
};

function textOf(body: string): string {
	return body
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

describe('Svelte component regression coverage', () => {
	test('DiffView splits multi-file diffs and preserves per-file stats', () => {
		const body = render(DiffView, {
			props: {
				path: 'fallback.patch',
				collapsible: true,
				diff: [
					'diff --git a/src/a.ts b/src/a.ts',
					'--- a/src/a.ts',
					'+++ b/src/a.ts',
					'@@ -1 +1 @@',
					'-old a',
					'+new a',
					'diff --git a/src/b.ts b/src/b.ts',
					'--- a/src/b.ts',
					'+++ b/src/b.ts',
					'@@ -1,0 +1 @@',
					'+new b'
				].join('\n')
			}
		}).body;

		expect(body).toContain('aria-label="Collapse src/a.ts"');
		expect(body).toContain('aria-label="Collapse src/b.ts"');
		expect(body).toMatch(/<code class="path [^"]+">src\/a\.ts<\/code>/);
		expect(body).toMatch(/<code class="path [^"]+">src\/b\.ts<\/code>/);
		expect(body).toMatch(/<span class="added [^"]+">\+1<\/span>/);
		expect(body).toMatch(/<span class="removed [^"]+">−1<\/span>/);
		expect(body).toContain('role="table"');
	});

	test('DiffView refuses oversized diffs instead of parsing them', () => {
		const body = render(DiffView, {
			props: {
				path: 'huge.patch',
				diff: '+'.repeat(MAX_RENDERABLE_DIFF_CHARS + 1)
			}
		}).body;

		expect(body).toContain('Diff is too large to render safely');
		expect(body).toContain((MAX_RENDERABLE_DIFF_CHARS + 1).toLocaleString());
		expect(body).not.toContain('role="table"');
	});

	test('InteractiveRequestDialog renders narrow filesystem grant choices and raw args', () => {
		const request: InteractiveRequestView = {
			requestId: 'perm-1',
			kind: 'permission',
			tool: 'view',
			permissionKind: 'read',
			summary: '/tmp/secrets.env',
			args: { path: '/tmp/secrets.env', forceReadLargeFiles: true },
			userPolicy: 'prompt'
		};
		const body = render(InteractiveRequestDialog, {
			props: { request, onRespond: () => undefined }
		}).body;

		expect(body).toContain('role="alertdialog"');
		expect(body).toContain('Just this exact read');
		expect(body).toContain('Anywhere under `/tmp/`');
		expect(body).toContain('"forceReadLargeFiles": true');
		expect(body).toContain('Allow always');
	});

	test('InteractiveRequestDialog requires explicit shell scopes before persistent allow', () => {
		const request: InteractiveRequestView = {
			requestId: 'perm-2',
			kind: 'permission',
			tool: 'bash',
			permissionKind: 'shell',
			summary: 'git status | grep src',
			args: { command: 'git status | grep src' },
			userPolicy: 'prompt',
			shellAnalysis: {
				kind: 'parsed',
				segments: [
					{ argv: ['git', 'status'], followingOp: '|' },
					{ argv: ['grep', 'src'], followingOp: null }
				]
			}
		};
		const body = render(InteractiveRequestDialog, {
			props: { request, onRespond: () => undefined }
		}).body;
		const text = textOf(body);

		expect(text).toContain('Pipeline (2 commands)');
		expect(body).toContain('Any `git` command (any subcommand, any args)');
		expect(body).toContain('Any `git status` command (any args)');
		expect(body).toContain('Any `grep` command (any subcommand, any args)');
		expect(body).toContain('Check at least one scope above to remember this allow.');
		expect(body).toMatch(/<button[^>]+class="btn primary"[^>]+disabled/);
	});

	test('Chat composes pending interactive prompts into the initial transcript', () => {
		const pending: InteractiveRequestView = {
			requestId: 'perm-chat',
			kind: 'permission',
			tool: 'bash',
			permissionKind: 'shell',
			summary: 'pnpm test',
			args: { command: 'pnpm test' },
			userPolicy: 'prompt',
			canPersistDecision: false
		};
		const body = render(Chat, {
			props: {
				conversation,
				initialMessages: [],
				initialPendingInteractive: [pending],
				providerCapabilities,
				providerDisplayName: 'Copilot',
				chatPlaceholder: 'Ask Copilot'
			}
		}).body;

		expect(body).toMatch(/<h2 class="[^"]+">Regression chat<\/h2>/);
		expect(body).toContain('Permission required');
		expect(body).not.toContain('Allow always');
		expect(body).toContain('placeholder="Ask Copilot"');
	});

	test('FileBrowser renders safe empty states without client fetch data', () => {
		const body = render(FileBrowser, {
			props: { conversationId: 'conv-1', pane: 'changes' }
		}).body;

		expect(body).toContain('aria-label="Git status"');
		expect(body).toContain('Working tree clean.');
		expect(body).toContain('Select a file or commit to view it.');
	});
});
