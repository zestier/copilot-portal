<script lang="ts">
	import {
		describeGrantScope,
		formatExpiry,
		formatTime,
		grantScopeLabel,
		type FormResult,
		type PermissionGrant
	} from './settings-types';
	import {
		FS_RULE_BEHAVIORS_WITH_VALUE,
		FS_RULE_ROOTS,
		type FsRuleBehaviorWithValue,
		type FsRuleRoot,
		type ShellCommandStep,
		type ShellOptionRules,
		type ShellOptionSpec
	} from '$lib/permissions/scope-types';

	let { grants, form }: { grants: PermissionGrant[]; form: FormResult | null } = $props();

	type GrantTool = 'shell' | 'read' | 'write' | 'edit' | 'url';
	type ShellPositionalsKind =
		| 'unset'
		| 'none'
		| 'any'
		| 'workspace-paths'
		| 'session-workspace-paths';
	type ShellPipelineKind = 'unset' | 'must' | 'forbid';
	type FsRootKind = FsRuleRoot;
	type FsBehaviorKind = 'any' | FsRuleBehaviorWithValue;
	type UrlRuleKind = 'exact' | 'host' | 'host-suffix';
	type GrantDecision = 'allow' | 'force-allow' | 'deny' | 'prompt';

	let newGrantTool = $state<GrantTool>('shell');
	let newGrantDecision = $state<GrantDecision>('allow');
	let newGrantExpiry = $state('');
	let newGrantDenyReason = $state('');
	let editingGrantId = $state<number | null>(null);
	let editingGrantMeta = $state<{
		conversationId: string | null;
		conversationTitle: string | null;
	} | null>(null);
	let detailsOpen = $state(false);
	let editorDetails: HTMLDetailsElement | undefined = $state();

	let searchQuery = $state('');
	let decisionFilter = $state<'all' | GrantDecision>('all');
	let toolFilter = $state('all');
	let kindFilter = $state('all');
	let scopeFilter = $state<'all' | 'global' | 'conversation'>('all');
	let expiryFilter = $state<'all' | 'never' | 'expiring' | 'expired'>('all');
	let provenanceFilter = $state<'all' | PermissionGrant['source']>('all');

	let shellArgv0 = $state('');
	let shellSubcommands = $state('');
	let shellPositionals = $state<ShellPositionalsKind>('unset');
	let shellPipeline = $state<ShellPipelineKind>('unset');
	let shellStepOptions = $state<ShellStepOptionInput[]>([{ allow: '', deny: '' }]);
	let originalShellCommand = $state<ShellCommandStep[] | null>(null);

	let fsRoot = $state<FsRootKind>('workspace');
	let fsBehavior = $state<FsBehaviorKind>('any');
	let fsValue = $state('');

	let urlRuleKind = $state<UrlRuleKind>('host');
	let urlExact = $state('');
	let urlHost = $state('');
	let urlSuffix = $state('');

	function csvToList(s: string): string[] {
		return s
			.split(',')
			.map((t) => t.trim())
			.filter((t) => t.length > 0);
	}

	function parseShellOptionSpecs(input: string): ShellOptionSpec[] {
		return csvToList(input).map((entry) => {
			const split = entry.indexOf('=');
			if (split === -1) {
				if (!entry.startsWith('-')) {
					throw new Error(`option name "${entry}" must start with '-'`);
				}
				return { name: entry, kind: 'flag' };
			}
			const name = entry.slice(0, split).trim();
			const valueKind = entry.slice(split + 1).trim();
			if (!name.startsWith('-')) {
				throw new Error(`option name "${name}" must start with '-'`);
			}
			if (valueKind !== 'any' && valueKind !== 'workspace-path') {
				throw new Error(`option "${name}" must end with =any or =workspace-path`);
			}
			const valueRule =
				valueKind === 'any' ? ({ kind: 'any' } as const) : ({ kind: 'workspace-path' } as const);
			return {
				name,
				kind: 'option',
				value: valueRule
			};
		});
	}

	function shellOptionSpecsToCsv(specs: ShellOptionSpec[]): string {
		return specs
			.map((spec) => (spec.kind === 'flag' ? spec.name : `${spec.name}=${spec.value.kind}`))
			.join(', ');
	}

	function commandTailToText(command: ShellCommandStep[] | undefined): string {
		return (command ?? [])
			.slice(1)
			.map((step) => step.token)
			.join(' ');
	}

	function fsRootLabel(root: FsRootKind): string {
		switch (root) {
			case 'workspace':
				return 'workspace';
			case 'session-workspace':
				return 'SDK session workspace';
			case 'absolute':
				return 'absolute path';
		}
	}

	function fsBehaviorLabel(behavior: FsBehaviorKind): string {
		switch (behavior) {
			case 'any':
				return 'any path inside the root';
			case 'exact':
				return 'one exact path';
			case 'prefix':
				return 'path or anything inside it';
			case 'glob':
				return 'path matching a glob';
		}
	}

	type BuildResult = { json: string; error: null } | { json: null; error: string };
	type ShellStepOptionInput = { allow: string; deny: string };

	const shellCommandTokens = $derived([
		shellArgv0.trim(),
		...shellSubcommands
			.split(/\s+/)
			.map((t) => t.trim())
			.filter(Boolean)
	]);

	$effect(() => {
		const next = shellCommandTokens.map((token, i) => {
			const existing = shellStepOptions[i];
			if (existing) return existing;
			const original = originalShellCommand?.[i];
			if (original?.token === token) {
				return {
					allow: shellOptionSpecsToCsv(original.options?.allow ?? []),
					deny: (original.options?.deny ?? []).join(', ')
				};
			}
			return { allow: '', deny: '' };
		});
		const changed =
			next.length !== shellStepOptions.length ||
			next.some((entry, i) => entry !== shellStepOptions[i]);
		if (changed) shellStepOptions = next.length > 0 ? next : [{ allow: '', deny: '' }];
	});

	function updateShellStepOption(index: number, field: keyof ShellStepOptionInput, value: string) {
		shellStepOptions = shellStepOptions.map((entry, i) =>
			i === index ? { ...entry, [field]: value } : entry
		);
	}

	function buildScopeJson(): BuildResult {
		try {
			if (newGrantTool === 'shell') {
				if (!shellArgv0.trim()) return { json: null, error: 'argv0 is required' };
				const command: ShellCommandStep[] = shellCommandTokens.map((token) => ({ token }));
				const rule: Record<string, unknown> = { command };
				if (shellPositionals !== 'unset') rule.positionals = { kind: shellPositionals };
				if (shellPipeline !== 'unset') rule.pipeline = shellPipeline;
				for (let i = 0; i < command.length; i++) {
					const allow = parseShellOptionSpecs(shellStepOptions[i]?.allow ?? '');
					const deny = csvToList(shellStepOptions[i]?.deny ?? '');
					if (allow.length === 0 && deny.length === 0) continue;
					const options: ShellOptionRules = {};
					if (allow.length > 0) options.allow = allow;
					if (deny.length > 0) options.deny = deny;
					command[i].options = options;
				}
				return { json: JSON.stringify({ kind: 'shell', rule }), error: null };
			}
			if (newGrantTool === 'url') {
				let rule: Record<string, unknown>;
				switch (urlRuleKind) {
					case 'exact':
						if (!urlExact.trim()) return { json: null, error: 'URL is required' };
						rule = { kind: 'exact', url: urlExact.trim() };
						break;
					case 'host':
						if (!urlHost.trim()) return { json: null, error: 'host is required' };
						rule = { kind: 'host', host: urlHost.trim() };
						break;
					case 'host-suffix':
						if (!urlSuffix.trim()) return { json: null, error: 'suffix is required' };
						rule = { kind: 'host-suffix', suffix: urlSuffix.trim() };
						break;
				}
				return { json: JSON.stringify({ kind: 'url', rule }), error: null };
			}

			const perms = [newGrantTool] as ('read' | 'write' | 'edit')[];
			let rule: Record<string, unknown>;
			if (fsBehavior === 'any') {
				if (fsRoot === 'absolute') {
					return { json: null, error: 'absolute root requires exact, prefix, or glob behavior' };
				}
				rule = { kind: 'path', root: fsRoot, behavior: 'any' };
			} else {
				const value = fsValue.trim();
				if (!value) return { json: null, error: 'path or glob value is required' };
				rule = { kind: 'path', root: fsRoot, behavior: fsBehavior, value };
			}
			return { json: JSON.stringify({ kind: 'fs', perms, rule }), error: null };
		} catch (e) {
			return { json: null, error: e instanceof Error ? e.message : String(e) };
		}
	}

	const buildResult = $derived<BuildResult>(
		(() => {
			void newGrantTool;
			void shellArgv0;
			void shellSubcommands;
			void shellPositionals;
			void shellPipeline;
			void shellStepOptions;
			void fsRoot;
			void fsBehavior;
			void fsValue;
			void urlRuleKind;
			void urlExact;
			void urlHost;
			void urlSuffix;
			return buildScopeJson();
		})()
	);
	const scopeJsonPreview = $derived(buildResult.json ?? '');
	let userTouched = $state(false);
	const buildError = $derived(userTouched ? buildResult.error : null);

	$effect(() => {
		if (fsRoot === 'absolute' && fsBehavior === 'any') {
			fsBehavior = 'exact';
		}
	});

	function onSubmitCreateGrant(e: SubmitEvent) {
		const result = buildScopeJson();
		if (!result.json) {
			userTouched = true;
			e.preventDefault();
			return;
		}
		const formEl = e.currentTarget as HTMLFormElement;
		const hidden = formEl.elements.namedItem('scopeJson') as
			| HTMLInputElement
			| RadioNodeList
			| null;
		if (hidden && 'value' in hidden && !(hidden instanceof RadioNodeList)) {
			(hidden as HTMLInputElement).value = result.json;
		}
	}

	function resetGrantForm() {
		editingGrantId = null;
		editingGrantMeta = null;
		newGrantTool = 'shell';
		newGrantDecision = 'allow';
		newGrantExpiry = '';
		newGrantDenyReason = '';
		shellArgv0 = '';
		shellSubcommands = '';
		shellPositionals = 'unset';
		shellPipeline = 'unset';
		shellStepOptions = [{ allow: '', deny: '' }];
		originalShellCommand = null;
		fsRoot = 'workspace';
		fsBehavior = 'any';
		fsValue = '';
		urlRuleKind = 'host';
		urlExact = '';
		urlHost = '';
		urlSuffix = '';
		userTouched = false;
	}

	function expiryToLocalInput(ms: number | null): string {
		if (ms == null) return '';
		const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
		return d.toISOString().slice(0, 16);
	}

	function startEditGrant(g: PermissionGrant) {
		resetGrantForm();
		editingGrantId = g.id;
		editingGrantMeta = {
			conversationId: g.conversationId,
			conversationTitle: g.conversationTitle
		};
		newGrantDecision = g.decision;
		newGrantExpiry = expiryToLocalInput(g.expiresAt);
		newGrantDenyReason = g.denyReason ?? '';

		if (
			g.tool === 'shell' ||
			g.tool === 'url' ||
			g.tool === 'read' ||
			g.tool === 'write' ||
			g.tool === 'edit'
		) {
			newGrantTool = g.tool;
		}

		const sc = g.scope;
		if (sc) {
			if (sc.kind === 'shell') {
				originalShellCommand = sc.rule.command;
				shellArgv0 = sc.rule.command[0]?.token ?? '';
				shellSubcommands = commandTailToText(sc.rule.command);
				shellPositionals = sc.rule.positionals?.kind ?? 'unset';
				shellPipeline = sc.rule.pipeline ?? 'unset';
				shellStepOptions = sc.rule.command.map((step) => ({
					allow: shellOptionSpecsToCsv(step.options?.allow ?? []),
					deny: (step.options?.deny ?? []).join(', ')
				}));
			} else if (sc.kind === 'url') {
				urlRuleKind = sc.rule.kind;
				if (sc.rule.kind === 'exact') urlExact = sc.rule.url;
				else if (sc.rule.kind === 'host') urlHost = sc.rule.host;
				else urlSuffix = sc.rule.suffix;
			} else if (sc.kind === 'fs') {
				fsRoot = sc.rule.root;
				fsBehavior = sc.rule.behavior;
				fsValue = 'value' in sc.rule ? sc.rule.value : '';
			}
		}

		detailsOpen = true;
		queueMicrotask(() => {
			editorDetails?.scrollIntoView({
				behavior: 'smooth',
				block: 'start'
			});
			(
				editorDetails?.querySelector('select, input, textarea, button') as HTMLElement | null
			)?.focus();
		});
	}

	$effect(() => {
		if (
			form?.ok &&
			(form.formId === 'createGrant' || form.formId === 'updateGrant') &&
			!form.duplicate
		) {
			resetGrantForm();
		}
	});

	function canEditGrant(g: PermissionGrant): boolean {
		if (g.scope === null) return false;
		if (g.scope.kind === 'any') return false;
		if (!['shell', 'read', 'write', 'edit', 'url'].includes(g.tool)) return false;
		if (g.scope.kind === 'fs' && g.scope.perms && g.scope.perms.length > 1) return false;
		return true;
	}

	function resetFilters() {
		searchQuery = '';
		decisionFilter = 'all';
		toolFilter = 'all';
		kindFilter = 'all';
		scopeFilter = 'all';
		expiryFilter = 'all';
		provenanceFilter = 'all';
	}

	function isExpired(g: PermissionGrant): boolean {
		return g.expiresAt !== null && g.expiresAt <= Date.now();
	}

	function isExpiringSoon(g: PermissionGrant): boolean {
		return (
			g.expiresAt !== null && g.expiresAt > Date.now() && g.expiresAt <= Date.now() + 7 * 86_400_000
		);
	}

	function expiryStateLabel(g: PermissionGrant): string {
		if (isExpired(g)) return 'Expired';
		if (isExpiringSoon(g)) return 'Expiring soon';
		if (g.expiresAt === null) return 'No expiry';
		return 'Scheduled expiry';
	}

	function provenanceLabel(g: PermissionGrant): string {
		switch (g.source) {
			case 'seed':
				return 'Default seed';
			case 'prompt':
				return 'Prompt-created';
			case 'settings':
				return 'Settings-created';
			case 'legacy':
				return 'Legacy';
		}
	}

	function decisionLabel(decision: GrantDecision): string {
		switch (decision) {
			case 'allow':
				return 'Approve';
			case 'force-allow':
				return 'Force approve';
			case 'deny':
				return 'Deny';
			case 'prompt':
				return 'Prompt';
		}
	}

	function groupSearchText(g: PermissionGrant): string {
		return [
			String(g.id),
			g.tool,
			g.permissionKind ?? 'any kind',
			g.decision,
			describeGrantScope(g),
			grantScopeLabel(g),
			g.conversationId ?? '',
			g.denyReason ?? '',
			provenanceLabel(g),
			JSON.stringify(g.scope ?? g.scopePattern ?? '')
		]
			.join(' ')
			.toLowerCase();
	}

	function matchesFilters(g: PermissionGrant): boolean {
		const q = searchQuery.trim().toLowerCase();
		if (q && !groupSearchText(g).includes(q)) return false;
		if (decisionFilter !== 'all' && g.decision !== decisionFilter) return false;
		if (toolFilter !== 'all' && g.tool !== toolFilter) return false;
		if (kindFilter !== 'all' && (g.permissionKind ?? 'any kind') !== kindFilter) return false;
		if (scopeFilter === 'global' && g.conversationId !== null) return false;
		if (scopeFilter === 'conversation' && g.conversationId === null) return false;
		if (provenanceFilter !== 'all' && g.source !== provenanceFilter) return false;
		if (expiryFilter === 'never' && g.expiresAt !== null) return false;
		if (expiryFilter === 'expiring' && !isExpiringSoon(g)) return false;
		if (expiryFilter === 'expired' && !isExpired(g)) return false;
		return true;
	}

	function getGrantStats(items: PermissionGrant[]) {
		return {
			total: items.length,
			allow: items.filter((g) => g.decision === 'allow' || g.decision === 'force-allow').length,
			deny: items.filter((g) => g.decision === 'deny').length,
			prompt: items.filter((g) => g.decision === 'prompt').length,
			global: items.filter((g) => g.conversationId === null).length,
			conversation: items.filter((g) => g.conversationId !== null).length,
			seed: items.filter((g) => g.source === 'seed').length,
			expiring: items.filter(isExpiringSoon).length,
			expired: items.filter(isExpired).length
		};
	}

	function buildGrantSections(items: PermissionGrant[]) {
		const deny = items.filter((g) => g.decision === 'deny');
		const prompt = items.filter((g) => g.decision === 'prompt');
		const userGlobal = items.filter(
			(g) =>
				(g.decision === 'allow' || g.decision === 'force-allow') &&
				g.source !== 'seed' &&
				g.conversationId === null
		);
		const conversation = items.filter(
			(g) =>
				(g.decision === 'allow' || g.decision === 'force-allow') &&
				g.source !== 'seed' &&
				g.conversationId !== null
		);
		const defaults = items.filter(
			(g) => (g.decision === 'allow' || g.decision === 'force-allow') && g.source === 'seed'
		);

		return [
			{
				id: 'deny',
				title: 'Hard deny rules',
				description:
					'Rules that absolutely reject matching requests. They never prompt and forcePermissionPrompt cannot override them.',
				grants: deny
			},
			{
				id: 'prompt',
				title: 'Prompt-required rules',
				description:
					'Rules that block automated approval but allow a human permission dialog or forcePermissionPrompt escalation.',
				grants: prompt
			},
			{
				id: 'user-global',
				title: 'Non-seed global approvals',
				description: 'Approve rules not marked as default seeds that apply across conversations.',
				grants: userGlobal
			},
			{
				id: 'conversation',
				title: 'Conversation-scoped approvals',
				description: 'Approve rules created from a specific conversation prompt.',
				grants: conversation
			},
			{
				id: 'defaults',
				title: 'Default seed approvals',
				description: 'Built-in safe defaults installed for each user; revocable and restorable.',
				grants: defaults
			}
		].filter((section) => section.grants.length > 0);
	}

	const toolOptions = $derived([...new Set(grants.map((g) => g.tool))].sort());
	const kindOptions = $derived(
		[...new Set(grants.map((g) => g.permissionKind ?? 'any kind'))].sort()
	);
	const stats = $derived(getGrantStats(grants));
	const filteredGrants = $derived(grants.filter(matchesFilters));
	const filteredStats = $derived(getGrantStats(filteredGrants));
	const grantSections = $derived(buildGrantSections(filteredGrants));
	const hasActiveFilters = $derived(
		searchQuery.trim().length > 0 ||
			decisionFilter !== 'all' ||
			toolFilter !== 'all' ||
			kindFilter !== 'all' ||
			scopeFilter !== 'all' ||
			expiryFilter !== 'all' ||
			provenanceFilter !== 'all'
	);
</script>

<div
	id="settings-panel-permissions"
	class="tab-panel grants"
	role="tabpanel"
	aria-labelledby="settings-tab-permissions"
>
	<div class="section-heading">
		<h2>Saved permission grants</h2>
		<p class="muted small">
			Review persistent approve, deny, and prompt rules; audit defaults; and find
			conversation-scoped rules quickly.
		</p>
	</div>

	<div class="grant-summary" aria-label="Permission grant summary">
		<div class="summary-card">
			<span class="summary-value">{stats.total}</span>
			<span class="summary-label">Total grants</span>
		</div>
		<div class="summary-card">
			<span class="summary-value">{stats.allow}</span>
			<span class="summary-label">Approvals</span>
		</div>
		<div class="summary-card danger-card">
			<span class="summary-value">{stats.deny}</span>
			<span class="summary-label">Denies</span>
		</div>
		<div class="summary-card warning-card">
			<span class="summary-value">{stats.prompt}</span>
			<span class="summary-label">Prompts</span>
		</div>
		<div class="summary-card">
			<span class="summary-value">{stats.seed}</span>
			<span class="summary-label">Default seeds</span>
		</div>
		<div class="summary-card">
			<span class="summary-value">{stats.conversation}</span>
			<span class="summary-label">Conversation-scoped</span>
		</div>
		<div class="summary-card warning-card">
			<span class="summary-value">{stats.expiring + stats.expired}</span>
			<span class="summary-label">Expiring/expired</span>
		</div>
	</div>

	<div class="grant-toolbar">
		<details class="add-grant" bind:open={detailsOpen} bind:this={editorDetails}>
			<summary
				>{editingGrantId !== null ? 'Edit permission grant' : 'Add a permission grant'}</summary
			>
			<form
				method="POST"
				action={editingGrantId !== null ? '?/updateGrant' : '?/createGrant'}
				class="add-grant-form"
				onsubmit={onSubmitCreateGrant}
			>
				{#if editingGrantId !== null}
					<p class="muted small">
						Editing grant #{editingGrantId}{editingGrantMeta?.conversationId
							? ` (scoped to ${editingGrantMeta.conversationTitle ?? editingGrantMeta.conversationId})`
							: ' (user-global)'}. The conversation scope and original grant time are preserved.
					</p>
					<input type="hidden" name="id" value={editingGrantId} />
				{:else}
					<p class="muted small">
						Author a user-global grant directly, without waiting for a tool prompt.
						Conversation-scoped grants are still created from the "Allow always" / "Deny always"
						buttons on the in-chat permission dialog.
					</p>
				{/if}

				<div class="grid">
					<label>
						Decision
						<select name="decision" bind:value={newGrantDecision}>
							<option value="allow">Approve</option>
							<option value="deny">Deny</option>
							<option value="prompt">Prompt</option>
						</select>
					</label>
					<label>
						Tool
						<select name="tool" bind:value={newGrantTool}>
							<option value="shell">shell (run a command)</option>
							<option value="read">read (file read)</option>
							<option value="write">write (file write)</option>
							<option value="edit">edit (file edit)</option>
							<option value="url">url (fetch URL)</option>
						</select>
					</label>
					<label>
						Expires (optional)
						<input type="datetime-local" name="expiresAt" bind:value={newGrantExpiry} />
					</label>
				</div>

				{#if newGrantDecision === 'deny'}
					<label class="deny-reason">
						Deny reason / feedback (optional)
						<textarea
							name="denyReason"
							bind:value={newGrantDenyReason}
							rows="2"
							maxlength="500"
							placeholder="e.g. Prefer the structured `view` tool instead of `cat`."
						></textarea>
						<span class="muted small"
							>Surfaced to the agent as the SDK reject `feedback` string — explain *why* and what to
							do instead. Max 500 chars.</span
						>
					</label>
				{:else}
					<input type="hidden" name="denyReason" value="" />
					{#if newGrantDecision === 'prompt'}
						<p class="muted small">
							Prompt grants block automated approval but allow a human permission dialog or
							forcePermissionPrompt escalation. Persistent choices are disabled for those dialogs;
							edit or remove the prompt grant here to change that behavior.
						</p>
					{/if}
				{/if}

				{#if newGrantTool === 'shell'}
					<fieldset class="scope-fields">
						<legend>Shell scope</legend>
						<label>
							argv0 (the bare command name)
							<input
								type="text"
								bind:value={shellArgv0}
								placeholder="cd"
								spellcheck="false"
								autocomplete="off"
							/>
							<span class="muted small">No slashes, no leading dot — just the program name.</span>
						</label>
						<label>
							Subcommand path (optional, space-separated)
							<input
								type="text"
								bind:value={shellSubcommands}
								placeholder="remote set-url"
								spellcheck="false"
								autocomplete="off"
							/>
							<span class="muted small"
								>Each token extends the command path. Options can be configured for every command
								step below.</span
							>
						</label>
						<label>
							Positional arguments
							<select bind:value={shellPositionals}>
								<option value="unset">(unconstrained — any positionals)</option>
								<option value="none">none (the command takes no positional args)</option>
								<option value="any">any (positionals are anything)</option>
								<option value="workspace-paths"
									>workspace-paths (every positional must resolve inside the conversation's
									workspace)</option
								>
								<option value="session-workspace-paths"
									>session-workspace-paths (every positional must resolve inside the SDK session
									workspace)</option
								>
							</select>
						</label>
						<label>
							Pipeline constraint
							<select bind:value={shellPipeline}>
								<option value="unset">(no constraint — matches regardless of `|` neighbours)</option
								>
								<option value="must"
									>must — only matches when the command is part of a pipeline (`a | b`)</option
								>
								<option value="forbid"
									>forbid — only matches when the command is NOT pipelined</option
								>
							</select>
							<span class="muted small"
								>Useful for deny grants that nudge toward structured alternatives: `pipeline=forbid`
								lets `cmd | grep ...` keep working while rejecting bare `grep`.</span
							>
						</label>
						<div class="step-options">
							<p class="muted small">
								Option-spec syntax: bare names are boolean flags; `name=any` and
								`name=workspace-path` consume a value (`name value` or `name=value`). Options on a
								non-final step are consumed before matching the next command token; options on the
								final step may be interleaved with positionals.
							</p>
							{#each shellCommandTokens as token, i}
								<fieldset class="step-option-fields">
									<legend>
										Options after `{token || '(argv0)'}`
										{#if i === 0}
											<span class="muted">(base command)</span>
										{:else if i === shellCommandTokens.length - 1}
											<span class="muted">(final step)</span>
										{:else}
											<span class="muted">(intermediate step)</span>
										{/if}
									</legend>
									<label>
										Allow list (optional, comma-separated)
										<input
											type="text"
											value={shellStepOptions[i]?.allow ?? ''}
											oninput={(e) => updateShellStepOption(i, 'allow', e.currentTarget.value)}
											placeholder={i === 0 ? '--no-pager, -C=any' : '-v, --format=any'}
											spellcheck="false"
											autocomplete="off"
										/>
									</label>
									<label>
										Deny list (optional, comma-separated)
										<input
											type="text"
											value={shellStepOptions[i]?.deny ?? ''}
											oninput={(e) => updateShellStepOption(i, 'deny', e.currentTarget.value)}
											placeholder={i === 0 ? '--git-dir, -C' : '--upload-pack'}
											spellcheck="false"
											autocomplete="off"
										/>
									</label>
								</fieldset>
							{/each}
						</div>
					</fieldset>
				{:else if newGrantTool === 'url'}
					<fieldset class="scope-fields">
						<legend>URL scope</legend>
						<label>
							Match by
							<select bind:value={urlRuleKind}>
								<option value="exact">exact URL</option>
								<option value="host">exact host</option>
								<option value="host-suffix">host suffix (e.g. *.github.com)</option>
							</select>
						</label>
						{#if urlRuleKind === 'exact'}
							<label>
								URL
								<input
									type="url"
									bind:value={urlExact}
									placeholder="https://api.github.com/users/octocat"
									autocomplete="off"
								/>
							</label>
						{:else if urlRuleKind === 'host'}
							<label>
								Host
								<input
									type="text"
									bind:value={urlHost}
									placeholder="api.github.com"
									autocomplete="off"
								/>
							</label>
						{:else}
							<label>
								Suffix
								<input
									type="text"
									bind:value={urlSuffix}
									placeholder="github.com"
									autocomplete="off"
								/>
								<span class="muted small"
									>Matches hosts equal to `suffix` or ending with `.suffix` (so `github.com` and
									`api.github.com` both match `github.com`).</span
								>
							</label>
						{/if}
					</fieldset>
				{:else}
					<fieldset class="scope-fields">
						<legend>Filesystem scope ({newGrantTool})</legend>
						<label>
							Root
							<select bind:value={fsRoot}>
								{#each FS_RULE_ROOTS as root}
									<option value={root}>{fsRootLabel(root)}</option>
								{/each}
							</select>
						</label>
						<label>
							Behavior
							<select bind:value={fsBehavior}>
								{#if fsRoot !== 'absolute'}
									<option value="any">{fsBehaviorLabel('any')}</option>
								{/if}
								{#each FS_RULE_BEHAVIORS_WITH_VALUE as behavior}
									<option value={behavior}>{fsBehaviorLabel(behavior)}</option>
								{/each}
							</select>
						</label>
						{#if fsBehavior !== 'any'}
							<label>
								{fsRoot === 'absolute' ? 'Absolute path or glob' : 'Relative path or glob'}
								<input
									type="text"
									bind:value={fsValue}
									placeholder={fsRoot === 'absolute'
										? '/workspaces/project/src/**/*.ts'
										: 'src/**/*.ts'}
									spellcheck="false"
									autocomplete="off"
								/>
								<span class="muted small"
									>Workspace and session-workspace values are relative to that root. Absolute values
									start with `/`. For glob, `*` matches one path segment and `**` matches any
									number.</span
								>
							</label>
						{/if}
					</fieldset>
				{/if}

				<input type="hidden" name="scopeJson" value={scopeJsonPreview} />

				{#if scopeJsonPreview}
					<details class="scope-preview">
						<summary>Preview JSON</summary>
						<pre><code>{scopeJsonPreview}</code></pre>
					</details>
				{/if}
				{#if buildError}
					<div class="err small">{buildError}</div>
				{/if}
				{#if form?.formId === 'createGrant' && form.error}
					<div class="err small">{form.error}</div>
				{/if}
				{#if form?.formId === 'createGrant' && form.ok}
					<div class="ok small">
						{form.duplicate ? 'An identical grant already exists — no change.' : 'Grant created.'}
					</div>
				{/if}
				{#if form?.formId === 'updateGrant' && form.error}
					<div class="err small">{form.error}</div>
				{/if}
				{#if form?.formId === 'updateGrant' && form.ok}
					<div class="ok small">Grant updated.</div>
				{/if}

				<div class="form-actions">
					<button class="btn primary" type="submit" disabled={!scopeJsonPreview}>
						{editingGrantId !== null ? 'Save changes' : 'Add grant'}
					</button>
					{#if editingGrantId !== null}
						<button class="btn" type="button" onclick={resetGrantForm}>Cancel</button>
					{/if}
				</div>
			</form>
		</details>

		<div class="grant-bulk-actions" aria-label="Grant maintenance actions">
			<form method="POST" action="?/restoreSeedGrants" class="restore-seeds">
				<button
					class="btn small"
					type="submit"
					title="Replace identifiable default seed grants with the current default set; user-created non-default rules are left alone"
				>
					Restore default seed grants
				</button>
			</form>
			{#if grants.length > 0}
				<form
					method="POST"
					action="?/revokeAllGrants"
					class="revoke-all"
					onsubmit={(e) => {
						if (
							!confirm(
								`Revoke all ${grants.length} saved permission grant${grants.length === 1 ? '' : 's'}? This removes default, user-created, and conversation-scoped grants. You can restore default seeds afterward, but user-created rules cannot be recovered.`
							)
						) {
							e.preventDefault();
						}
					}}
				>
					<button class="btn small danger" type="submit">Revoke all grants</button>
				</form>
			{/if}
		</div>
	</div>

	{#if grants.length === 0}
		<div class="empty-state">
			<h3>No saved grants yet</h3>
			<p class="muted small">
				No saved grants. When you click "Allow always" or "Deny always" on a tool prompt, the
				resulting approve or hard-deny rule shows up here so you can revoke it later. You can also
				add prompt-required rules here to force interactive approval for matching requests. The
				button above re-installs the built-in defaults (file/dir reads, structured tools, and safety
				rules).
			</p>
		</div>
	{:else}
		<form class="grant-filters" role="search" onsubmit={(e) => e.preventDefault()}>
			<div class="filter-header">
				<div>
					<h3>Find grants</h3>
					<p class="muted small">
						Showing {filteredStats.total} of {stats.total} grants. Hidden grants are only filtered from
						this view, not revoked.
					</p>
				</div>
				{#if hasActiveFilters}
					<button class="btn small" type="button" onclick={resetFilters}>Reset filters</button>
				{/if}
			</div>
			<label class="search-field">
				Search grants
				<input
					type="search"
					bind:value={searchQuery}
					placeholder="Search tool, scope, conversation, feedback, or grant id"
					autocomplete="off"
				/>
			</label>
			<div class="filter-grid">
				<label>
					Decision filter
					<select bind:value={decisionFilter}>
						<option value="all">All decisions</option>
						<option value="allow">Approve only</option>
						<option value="deny">Deny only</option>
						<option value="prompt">Prompt only</option>
					</select>
				</label>
				<label>
					Tool filter
					<select bind:value={toolFilter}>
						<option value="all">All tools</option>
						{#each toolOptions as tool}
							<option value={tool}>{tool}</option>
						{/each}
					</select>
				</label>
				<label>
					Permission kind filter
					<select bind:value={kindFilter}>
						<option value="all">All kinds</option>
						{#each kindOptions as kind}
							<option value={kind}>{kind}</option>
						{/each}
					</select>
				</label>
				<label>
					Scope filter
					<select bind:value={scopeFilter}>
						<option value="all">Global and conversation</option>
						<option value="global">Global only</option>
						<option value="conversation">Conversation-scoped only</option>
					</select>
				</label>
				<label>
					Expiration filter
					<select bind:value={expiryFilter}>
						<option value="all">All expiration states</option>
						<option value="never">No expiry</option>
						<option value="expiring">Expiring in 7 days</option>
						<option value="expired">Expired</option>
					</select>
				</label>
				<label>
					Source filter
					<select bind:value={provenanceFilter}>
						<option value="all">All sources</option>
						<option value="seed">Default seed</option>
						<option value="prompt">Prompt-created</option>
						<option value="settings">Settings-created</option>
						<option value="legacy">Legacy</option>
					</select>
				</label>
			</div>
		</form>

		{#if filteredGrants.length === 0}
			<div class="empty-state filtered-empty" aria-live="polite">
				<h3>No grants match these filters</h3>
				<p class="muted small">
					Broaden the search or reset filters to see the hidden {stats.total} saved grant{stats.total ===
					1
						? ''
						: 's'}.
				</p>
				<button class="btn small" type="button" onclick={resetFilters}>Reset filters</button>
			</div>
		{:else}
			<div class="filtered-summary" aria-live="polite">
				<span>{filteredStats.allow} approve</span>
				<span>{filteredStats.deny} deny</span>
				<span>{filteredStats.prompt} prompt</span>
				<span>{filteredStats.global} global</span>
				<span>{filteredStats.conversation} conversation-scoped</span>
				<span>{filteredStats.seed} default seed</span>
			</div>

			{#each grantSections as section (section.id)}
				<section class="grant-section" aria-labelledby={`grant-section-${section.id}`}>
					<div class="grant-section-heading">
						<div>
							<h3 id={`grant-section-${section.id}`}>{section.title}</h3>
							<p class="muted small">{section.description}</p>
						</div>
						<span class="section-count">{section.grants.length}</span>
					</div>
					<ul class="grant-list">
						{#each section.grants as g (g.id)}
							<li class="grant-row">
								<div class="grant-row-main">
									<div class="grant-row-title">
										<span class="decision-tag {g.decision}">{decisionLabel(g.decision)}</span>
										<code class="tool">{g.tool}</code>
										<span class="kind">{g.permissionKind ?? 'any kind'}</span>
										<span class="source-tag" class:seed={g.source === 'seed'}
											>{provenanceLabel(g)}</span
										>
										<span
											class="expiry-tag"
											class:warn={isExpiringSoon(g)}
											class:danger={isExpired(g)}>{expiryStateLabel(g)}</span
										>
									</div>
									<code class="pattern">{describeGrantScope(g)}</code>
									<div class="meta">
										<span>{grantScopeLabel(g)}</span>
										<span>Granted {formatTime(g.grantedAt)}</span>
										<span>Expires {formatExpiry(g.expiresAt)}</span>
									</div>
									{#if g.denyReason}
										<p class="deny-reason-row muted small">Feedback: {g.denyReason}</p>
									{/if}
								</div>
								<div class="grant-row-actions">
									<details class="grant-details">
										<summary>Details</summary>
										<dl>
											<div>
												<dt>Grant ID</dt>
												<dd>#{g.id}</dd>
											</div>
											<div>
												<dt>Scope</dt>
												<dd><code>{describeGrantScope(g)}</code></dd>
											</div>
											<div>
												<dt>Source</dt>
												<dd>{provenanceLabel(g)}</dd>
											</div>
											<div>
												<dt>Conversation</dt>
												<dd>{g.conversationId ? grantScopeLabel(g) : 'Global'}</dd>
											</div>
											{#if g.conversationId}
												<div>
													<dt>Conversation ID</dt>
													<dd><code>{g.conversationId}</code></dd>
												</div>
											{/if}
											{#if g.argsHash}
												<div>
													<dt>Args hash</dt>
													<dd><code>{g.argsHash}</code></dd>
												</div>
											{/if}
											{#if g.denyReason}
												<div>
													<dt>Feedback</dt>
													<dd>{g.denyReason}</dd>
												</div>
											{/if}
											<div>
												<dt>Raw scope</dt>
												<dd>
													<pre>{JSON.stringify(g.scope ?? g.scopePattern ?? '*', null, 2)}</pre>
												</dd>
											</div>
										</dl>
									</details>
									<form
										method="POST"
										action="?/revokeGrant"
										class="revoke"
										onsubmit={(e) => {
											if (
												!confirm(
													`Revoke grant #${g.id} (${g.decision} ${g.tool} ${describeGrantScope(g)})?`
												)
											) {
												e.preventDefault();
											}
										}}
									>
										<input type="hidden" name="id" value={g.id} />
										{#if canEditGrant(g)}
											<button
												class="btn small"
												type="button"
												onclick={() => startEditGrant(g)}
												title="Prefill the grant editor with this grant">Edit</button
											>
										{/if}
										<button class="btn small" type="submit">Revoke</button>
									</form>
								</div>
							</li>
						{/each}
					</ul>
				</section>
			{/each}
		{/if}
	{/if}
</div>

<style>
	.tab-panel {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 1rem;
	}
	.section-heading {
		margin-bottom: 1rem;
	}
	.section-heading h2 {
		margin: 0 0 0.25rem;
		font-size: 1.15rem;
	}
	.section-heading p {
		margin: 0;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		margin-bottom: 1.25rem;
	}
	form input,
	form select {
		width: 100%;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	code {
		background: var(--code-bg);
		padding: 0 0.25rem;
		border-radius: var(--radius-sm);
	}
	.form-actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-top: 0.25rem;
	}
	.grant-summary {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
		gap: 0.6rem;
		margin-bottom: 1rem;
	}
	.summary-card {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.7rem;
		background: color-mix(in srgb, var(--surface), var(--code-bg) 22%);
	}
	.summary-value {
		display: block;
		font-size: 1.35rem;
		font-weight: 700;
		line-height: 1;
	}
	.summary-label {
		display: block;
		margin-top: 0.25rem;
		font-size: 0.78rem;
		color: var(--muted, #888);
	}
	.danger-card .summary-value {
		color: var(--danger);
	}
	.warning-card .summary-value {
		color: var(--warning, #d99000);
	}
	.grant-toolbar {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 0.75rem;
		align-items: start;
		margin-bottom: 1rem;
	}
	.add-grant {
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.5rem 0.75rem;
	}
	.add-grant > summary {
		cursor: pointer;
		font-weight: 600;
	}
	.add-grant-form {
		margin-top: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.add-grant-form .grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 0.75rem;
	}
	.scope-fields {
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.5rem 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.scope-fields legend {
		padding: 0 0.25rem;
		font-size: 0.85em;
		color: var(--muted, #888);
	}
	.step-options {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.step-option-fields {
		border: 1px dashed var(--border);
		border-radius: 6px;
		padding: 0.5rem 0.75rem;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 0.75rem;
	}
	.step-option-fields legend {
		grid-column: 1 / -1;
	}
	.scope-preview pre {
		background: var(--code-bg, #1118);
		padding: 0.5rem;
		border-radius: 4px;
		overflow-x: auto;
		font-size: 0.85em;
	}
	.err {
		color: var(--danger, #d33);
	}
	.ok {
		color: var(--success);
		margin-left: 0.5rem;
	}
	.small {
		font-size: 0.85em;
	}
	.empty-state {
		border: 1px dashed var(--border);
		border-radius: var(--radius-sm);
		padding: 1rem;
		background: color-mix(in srgb, var(--surface), var(--code-bg) 15%);
	}
	.empty-state h3,
	.filter-header h3,
	.grant-section-heading h3 {
		margin: 0 0 0.2rem;
		font-size: 1rem;
	}
	.empty-state p,
	.filter-header p,
	.grant-section-heading p,
	.deny-reason-row {
		margin: 0;
	}
	.grant-filters {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.75rem;
		background: color-mix(in srgb, var(--surface), var(--code-bg) 12%);
	}
	.filter-header {
		display: flex;
		justify-content: space-between;
		gap: 0.75rem;
		align-items: start;
	}
	.search-field {
		margin-top: 0.2rem;
	}
	.filter-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 0.75rem;
	}
	.filtered-summary {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
		margin: 0 0 0.85rem;
	}
	.filtered-summary span,
	.section-count,
	.source-tag,
	.expiry-tag {
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0.12rem 0.5rem;
		font-size: 0.75rem;
		color: var(--muted, #888);
	}
	.grant-section {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		margin-top: 0.9rem;
		overflow: hidden;
	}
	.grant-section-heading {
		display: flex;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.75rem;
		border-bottom: 1px solid var(--border);
		background: color-mix(in srgb, var(--surface), var(--code-bg) 18%);
	}
	.grant-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
	}
	.grant-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 0.75rem;
		padding: 0.75rem;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
		font-size: 0.9em;
	}
	.grant-row:last-child {
		border-bottom: 0;
	}
	.grant-row-title {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
		margin-bottom: 0.45rem;
	}
	.decision-tag {
		font-size: 0.75em;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 0.1rem 0.4rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
	}
	.decision-tag.allow,
	.decision-tag.force-allow {
		color: var(--success);
		border-color: var(--success);
	}
	.decision-tag.prompt {
		color: var(--warning, #d99000);
		border-color: var(--warning, #d99000);
	}
	.decision-tag.deny {
		color: var(--danger);
		border-color: var(--danger);
	}
	.source-tag.seed {
		color: var(--success);
		border-color: color-mix(in srgb, var(--success), var(--border) 35%);
	}
	.expiry-tag.warn {
		color: var(--warning, #d99000);
		border-color: var(--warning, #d99000);
	}
	.expiry-tag.danger {
		color: var(--danger);
		border-color: var(--danger);
	}
	.grant-row .tool {
		font-weight: 600;
	}
	.grant-row .kind {
		font-size: 0.8em;
		opacity: 0.75;
	}
	.grant-row .pattern {
		display: block;
		font-family: var(--font-mono, monospace);
		font-size: 0.85em;
		opacity: 0.85;
		overflow-wrap: anywhere;
		white-space: normal;
		width: fit-content;
		max-width: 100%;
	}
	.grant-row .meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem 0.75rem;
		margin-top: 0.45rem;
		font-size: 0.8em;
		opacity: 0.75;
	}
	.deny-reason-row {
		margin-top: 0.45rem;
		overflow-wrap: anywhere;
	}
	.grant-row-actions {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		align-items: flex-end;
	}
	.grant-details {
		text-align: right;
	}
	.grant-details > summary {
		cursor: pointer;
	}
	.grant-details dl {
		margin: 0.5rem 0 0;
		width: min(32rem, 70vw);
		text-align: left;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.65rem;
		background: var(--surface);
	}
	.grant-details dl > div {
		display: grid;
		grid-template-columns: minmax(7rem, 0.35fr) minmax(0, 1fr);
		gap: 0.5rem;
		padding: 0.25rem 0;
	}
	.grant-details dt {
		font-weight: 600;
		color: var(--muted, #888);
	}
	.grant-details dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.grant-details pre {
		margin: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-size: 0.8rem;
	}
	.grant-row .revoke {
		flex-direction: row;
		gap: 0.35rem;
		margin: 0;
	}
	.revoke-all {
		margin: 0;
	}
	.grant-bulk-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		justify-content: flex-end;
	}
	.grant-bulk-actions > form {
		margin: 0;
	}
	.btn.small {
		padding: 0.2rem 0.55rem;
		font-size: 0.8em;
	}
	@media (max-width: 720px) {
		.grant-toolbar,
		.grant-row {
			grid-template-columns: 1fr;
		}
		.grant-bulk-actions,
		.grant-row-actions {
			align-items: stretch;
			justify-content: stretch;
		}
		.grant-details {
			text-align: left;
		}
		.grant-details dl {
			width: auto;
		}
		.grant-details dl > div {
			grid-template-columns: 1fr;
			gap: 0.15rem;
		}
	}
</style>
