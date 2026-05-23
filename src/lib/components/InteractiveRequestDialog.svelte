<script lang="ts">
	import type {
		InteractiveRequestView,
		InteractiveResponse,
		ElicitationSchema,
		ElicitationSchemaField,
		PermissionGrantScope,
		ShellAnalysisView,
		ShellAnalysisSegment
	} from '$lib/types';
	import { FS_PERMISSIONS, type GrantScope } from '$lib/permissions/scope-types';
	import { deriveScopeKey } from '$lib/permissions/scope-key';
	import {
		defaultPreSubcommandOptionsForArgv0,
		resolveSubcommandIndex
	} from '$lib/permissions/shell-argv';

	let {
		request,
		onRespond
	}: {
		request: InteractiveRequestView;
		onRespond: (r: InteractiveResponse) => void;
	} = $props();

	let busy = $state(false);

	async function pick(r: InteractiveResponse) {
		if (busy) return;
		busy = true;
		try {
			await onRespond(r);
		} finally {
			busy = false;
		}
	}

	// --- user_input state ---
	let userInputAnswer = $state('');

	// --- elicitation state ---
	type FieldValue = string | number | boolean | string[];
	let formValues = $state<Record<string, FieldValue>>({});
	function elicitationSchema(): ElicitationSchema | undefined {
		return request.kind === 'elicitation' ? request.requestedSchema : undefined;
	}
	function ensureDefaults() {
		const schema = elicitationSchema();
		if (!schema) return;
		for (const [key, f] of Object.entries(schema.properties)) {
			if (formValues[key] !== undefined) continue;
			if ('default' in f && f.default !== undefined) {
				formValues[key] = f.default as FieldValue;
			} else if (f.type === 'boolean') {
				formValues[key] = false;
			} else if (f.type === 'array') {
				formValues[key] = [];
			} else {
				formValues[key] = '';
			}
		}
	}
	$effect(() => {
		if (request.kind === 'elicitation') ensureDefaults();
	});

	function fieldLabel(name: string, f: ElicitationSchemaField): string {
		return f.title ?? name;
	}

	// Pretty-print permission `args` so the user can see exactly what the
	// tool will receive. The SDK's permission summary often collapses to
	// just a file name or command, hiding flags / payloads that matter.
	function formatArgs(args: unknown): string | null {
		if (args === null || args === undefined) return null;
		if (typeof args === 'string') return args.length > 0 ? args : null;
		try {
			const s = JSON.stringify(args, null, 2);
			return s && s !== '{}' && s !== '[]' ? s : null;
		} catch {
			return String(args);
		}
	}

	// --- permission scope picker state ---
	//
	// The scope choices the user picks from depend on the permission kind:
	//
	// - fs (`read` / `write` / `edit`): under the default 'prompt' policy
	//   the server already auto-allows any target inside the workspace
	//   root (see `decideByPolicy`). So a fs prompt that actually reaches
	//   the user is, by construction, for a path OUTSIDE the workspace —
	//   typically a config file in `$HOME`, a sibling repo, or a system
	//   path. We therefore deliberately do NOT offer "any read request"
	//   here: that label sounds tame ("just file reads") but in practice
	//   collapses the workspace boundary and grants the model unrestricted
	//   fs access. The only sensible "broader than this file" lever is
	//   "anywhere under this directory", which preserves a real boundary
	//   and matches the user's mental model. A user who genuinely wants
	//   "all reads everywhere" can add such a grant from Settings.
	//
	// - shell / url / other kinds: the historic four-step ladder still
	//   makes sense (this exact command/URL, any invocation of this tool
	//   for this kind, any invocation regardless of kind, everything).
	type ScopeChoice = 'this-exact' | 'this-directory' | 'tool-kind' | 'tool-any' | 'everything';

	const FS_KINDS = new Set<string>(FS_PERMISSIONS);

	const isFsKind = $derived(request.kind === 'permission' && FS_KINDS.has(request.permissionKind));

	const scopeChoices = $derived<ScopeChoice[]>(
		isFsKind
			? ['this-exact', 'this-directory']
			: ['this-exact', 'tool-kind', 'tool-any', 'everything']
	);

	let scopeChoice = $state<ScopeChoice>('this-exact');
	let expiryChoice = $state<'forever' | '1h' | '1d'>('forever');
	let appliesTo = $state<'this-conversation' | 'all-conversations'>('this-conversation');
	let denialFeedback = $state('');

	const HOUR_MS = 60 * 60 * 1000;
	const DAY_MS = 24 * HOUR_MS;

	const permissionScopeKey = $derived(
		request.kind === 'permission'
			? (deriveScopeKey(request.permissionKind, {
					fullCommandText: undefined,
					fileName: undefined,
					args: request.args
				}) ?? deriveFromSummary(request))
			: null
	);

	// Parent directory of the fs target, used as the prefix for the
	// "this-directory" scope. Null when we don't have a usable absolute
	// path (relative paths can't anchor a stable prefix grant).
	const fsParentDir = $derived(
		isFsKind && permissionScopeKey ? parentDirOf(permissionScopeKey) : null
	);

	const denyAllPolicy = $derived(
		request.kind === 'permission' && request.userPolicy === 'deny-all'
	);

	const canPersistDecision = $derived(
		request.kind === 'permission' && request.canPersistDecision !== false
	);

	function parentDirOf(p: string): string | null {
		if (!p || !p.startsWith('/')) return null;
		const i = p.lastIndexOf('/');
		if (i <= 0) return '/';
		return p.slice(0, i);
	}

	// SDK already collapsed scope into `summary`; for shell that's the full
	// command, for write/edit/read that's the file path. Use it as a
	// fallback scopeKey when the structured args path didn't yield one.
	function deriveFromSummary(
		req: Extract<InteractiveRequestView, { kind: 'permission' }>
	): string | null {
		const s = typeof req.summary === 'string' ? req.summary.trim() : '';
		return s.length > 0 && s !== req.tool ? s : null;
	}

	$effect(() => {
		void request.requestId;
		denialFeedback = '';
	});

	function denyFeedback(): string | undefined {
		const trimmed = denialFeedback.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}

	function pickDeny(decision: 'deny' | 'deny-always') {
		const feedback = denyFeedback();
		pick(feedback ? { kind: 'permission', decision, feedback } : { kind: 'permission', decision });
	}

	$effect(() => {
		if (request.kind !== 'permission') return;
		// Auto-select the narrowest scope we can support. For fs kinds we
		// prefer the exact-path option; if no scopeKey was derivable, fall
		// back to the directory option (which itself requires fsParentDir;
		// when neither is available the radio group will all be disabled
		// and "Allow always" simply doesn't persist a usable scope).
		if (isFsKind) {
			scopeChoice = permissionScopeKey ? 'this-exact' : 'this-directory';
		} else {
			scopeChoice = permissionScopeKey ? 'this-exact' : 'tool-kind';
		}
	});

	function buildScope(): PermissionGrantScope | undefined {
		if (request.kind !== 'permission') return undefined;
		const kind = request.permissionKind;
		switch (scopeChoice) {
			case 'this-exact':
				if (isFsKind && permissionScopeKey) {
					return {
						permissionKind: kind,
						scope: {
							kind: 'fs',
							perms: [kind as 'read' | 'write' | 'edit'],
							rule: { kind: 'path', root: 'absolute', behavior: 'exact', value: permissionScopeKey }
						}
					};
				}
				return permissionScopeKey
					? { permissionKind: kind, pattern: permissionScopeKey }
					: { permissionKind: kind, pattern: null };
			case 'this-directory':
				if (!fsParentDir) {
					// Shouldn't happen — the radio is disabled when null —
					// but fall back to exact-path if it does.
					return permissionScopeKey
						? { permissionKind: kind, pattern: permissionScopeKey }
						: { permissionKind: kind, pattern: null };
				}
				return {
					permissionKind: kind,
					scope: {
						kind: 'fs',
						perms: [kind as 'read' | 'write' | 'edit'],
						rule: { kind: 'path', root: 'absolute', behavior: 'prefix', value: fsParentDir }
					}
				};
			case 'tool-kind':
				return { permissionKind: kind, pattern: null };
			case 'tool-any':
				return { permissionKind: null, pattern: null };
			case 'everything':
				// Sentinel: omit scope entirely, server interprets as "no
				// kind/pattern restriction" but the row is still keyed on the
				// requested tool. This matches the legacy "Allow always"
				// semantics exactly.
				return undefined;
		}
	}

	function buildExpiry(): number | undefined {
		switch (expiryChoice) {
			case '1h':
				return HOUR_MS;
			case '1d':
				return DAY_MS;
			case 'forever':
			default:
				return undefined;
		}
	}

	// --- shell-specific scope picker ---
	//
	// For `shell` permission requests the server parser hands us a
	// segment list (or an "unsafe" verdict). The plain
	// "exact full command string" radio is essentially useless for
	// pipelines — that literal string almost never recurs — so we
	// generate structured per-argv0 / per-(argv0,subcommand) options
	// from the segments and let the user check several at once. Each
	// checked option becomes its own grant row on "Allow always".
	//
	// Subcommand heuristic: for known command families like `git`, resolve
	// the subcommand after supported global flags / options; otherwise fall
	// back to argv[1]. If the resolved token looks like a bare identifier
	// (matches /^[A-Za-z0-9][A-Za-z0-9_.:+-]*$/), we offer a
	// "Any `cmd sub`" option in addition to the broad "Any `cmd`".

	interface ShellScopeOption {
		id: string;
		label: string;
		summary: string;
		scope: GrantScope;
	}

	const shellAnalysis = $derived<ShellAnalysisView | null>(
		request.kind === 'permission' && request.permissionKind === 'shell'
			? (request.shellAnalysis ?? null)
			: null
	);

	const isShellRequest = $derived(
		request.kind === 'permission' && request.permissionKind === 'shell'
	);

	const isShellWithAnalysis = $derived(
		isShellRequest && shellAnalysis !== null && shellAnalysis.kind === 'parsed'
	);

	const isShellUnsafe = $derived(
		isShellRequest && shellAnalysis !== null && shellAnalysis.kind === 'unsafe'
	);

	const SUBCOMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9_.:+-]*$/;

	const shellOptions = $derived<ShellScopeOption[]>(
		shellAnalysis && shellAnalysis.kind === 'parsed'
			? buildShellOptions(shellAnalysis.segments)
			: []
	);

	let shellChecked = $state<Record<string, boolean>>({});

	// Reset the checkbox set whenever the request (or its analysed
	// segments) changes — stale checks from a previous prompt must not
	// leak into a new one.
	$effect(() => {
		void shellOptions;
		shellChecked = {};
	});

	function buildShellOptions(segments: ShellAnalysisSegment[]): ShellScopeOption[] {
		const out: ShellScopeOption[] = [];
		const seenArgv0 = new Set<string>();
		const seenSub = new Set<string>();
		for (const seg of segments) {
			const argv0 = seg.argv[0];
			if (typeof argv0 !== 'string' || argv0.length === 0) continue;
			// Skip anything the codec would reject server-side — keeps the
			// UI honest (every option we render is actually persistable).
			if (argv0.includes('/') || argv0.startsWith('.')) continue;
			if (!seenArgv0.has(argv0)) {
				seenArgv0.add(argv0);
				out.push({
					id: `argv0:${argv0}`,
					label: `Any \`${argv0}\` command (any subcommand, any args)`,
					summary: `any \`${argv0}\` invocation`,
					scope: {
						kind: 'shell',
						rule: { argv0, positionals: { kind: 'any' } }
					}
				});
			}
			const subIndex = resolveSubcommandIndex(
				seg.argv,
				defaultPreSubcommandOptionsForArgv0(argv0)
			).subcommandIndex;
			const sub = subIndex === null ? undefined : seg.argv[subIndex];
			if (
				typeof sub === 'string' &&
				!sub.startsWith('-') &&
				SUBCOMMAND_RE.test(sub) &&
				!seenSub.has(`${argv0} ${sub}`)
			) {
				seenSub.add(`${argv0} ${sub}`);
				out.push({
					id: `sub:${argv0}:${sub}`,
					label: `Any \`${argv0} ${sub}\` command (any args)`,
					summary: `any \`${argv0} ${sub}\` invocation`,
					scope: {
						kind: 'shell',
						rule: { argv0, subcommands: [sub], positionals: { kind: 'any' } }
					}
				});
			}
		}
		return out;
	}

	const shellCheckedCount = $derived(
		shellOptions.reduce((n, o) => n + (shellChecked[o.id] ? 1 : 0), 0)
	);

	function previewShellAlways(decision: 'allow-always' | 'deny-always'): string {
		const verb = decision === 'allow-always' ? 'Allow' : 'Deny';
		const where =
			appliesTo === 'all-conversations' ? 'in every conversation' : 'in this conversation';
		const ttl =
			expiryChoice === '1h' ? ', for 1 hour' : expiryChoice === '1d' ? ', for 1 day' : ', forever';
		const checked = shellOptions.filter((o) => shellChecked[o.id]);
		if (checked.length === 0) {
			return `${verb} … (pick at least one scope below) ${where}${ttl}.`;
		}
		const list = checked.map((o) => o.summary).join('; ');
		return `${verb} ${list} ${where}${ttl}.`;
	}

	function operatorGloss(op: ShellAnalysisSegment['followingOp']): string {
		switch (op) {
			case '&&':
				return 'then (only if previous succeeded)';
			case '||':
				return 'then (only if previous failed)';
			case ';':
				return 'then (regardless)';
			case '|':
				return 'piped to';
			default:
				return '';
		}
	}

	function pickAlways(decision: 'allow-always' | 'deny-always') {
		if (!canPersistDecision) return;
		if (decision === 'allow-always' && denyAllPolicy) return;
		// Shell branch: structured per-argv0 grants from the checkbox
		// picker take precedence over the legacy scope/pattern flow.
		if (isShellWithAnalysis && shellOptions.length > 0) {
			const checked = shellOptions.filter((o) => shellChecked[o.id]);
			if (checked.length === 0) {
				// Picker rendered but nothing checked — refuse to persist a
				// silent "any shell request" grant. The button is disabled
				// in this state; this guard catches keyboard activation.
				return;
			}
			const [first, ...rest] = checked;
			pick({
				kind: 'permission',
				decision,
				scope: { permissionKind: 'shell', scope: first.scope },
				additionalScopes: rest.map((o) => ({
					permissionKind: 'shell',
					scope: o.scope
				})),
				expiresInMs: buildExpiry(),
				applyToAllConversations: appliesTo === 'all-conversations',
				...(decision === 'deny-always' && denyFeedback() ? { feedback: denyFeedback() } : {})
			});
			return;
		}
		pick({
			kind: 'permission',
			decision,
			scope: buildScope(),
			expiresInMs: buildExpiry(),
			applyToAllConversations: appliesTo === 'all-conversations',
			...(decision === 'deny-always' && denyFeedback() ? { feedback: denyFeedback() } : {})
		});
	}

	function scopeOptionLabel(choice: ScopeChoice): string {
		if (request.kind !== 'permission') return choice;
		const tool = request.tool;
		const kind = request.permissionKind;
		switch (choice) {
			case 'this-exact':
				return permissionScopeKey
					? `Just this exact ${kind || 'request'}`
					: `Just this exact ${kind || 'request'} (unavailable)`;
			case 'this-directory':
				return fsParentDir
					? `Anywhere under \`${fsParentDir}/\``
					: `Anywhere under this directory (unavailable)`;
			case 'tool-kind':
				return `Any ${tool} (${kind}) request`;
			case 'tool-any':
				return `Any ${tool} request, regardless of kind`;
			case 'everything':
				return `Any request from this tool, regardless of kind or arguments (broadest)`;
		}
	}

	// One-line preview of what a *-always button will persist, shown under
	// the action row so users see the blast radius before clicking.
	function previewAlways(decision: 'allow-always' | 'deny-always'): string {
		if (request.kind !== 'permission') return '';
		const verb = decision === 'allow-always' ? 'Allow' : 'Deny';
		const tool = request.tool;
		const kind = request.permissionKind;
		const where =
			appliesTo === 'all-conversations' ? 'in every conversation' : 'in this conversation';
		const ttl =
			expiryChoice === '1h' ? ', for 1 hour' : expiryChoice === '1d' ? ', for 1 day' : ', forever';
		let what: string;
		switch (scopeChoice) {
			case 'this-exact':
				what = permissionScopeKey
					? `${tool} (${kind}) matching \`${permissionScopeKey}\``
					: `${tool} (${kind}) for any arguments`;
				break;
			case 'this-directory':
				what = fsParentDir
					? `${tool} (${kind}) under \`${fsParentDir}/\``
					: `${tool} (${kind}) under this directory`;
				break;
			case 'tool-kind':
				what = `any ${tool} (${kind}) request`;
				break;
			case 'tool-any':
				what = `any ${tool} request, regardless of kind`;
				break;
			case 'everything':
				what = `any request from ${tool}`;
				break;
		}
		return `${verb} ${what} ${where}${ttl}.`;
	}

	// --- keyboard shortcuts ---
	//
	// Enter         → Allow once
	// Shift+Enter   → Allow always (current scope/expiry)
	// Escape        → Deny
	//
	// Only fires when focus is explicitly on the dialog root (the user
	// clicked into the dialog area). We deliberately do NOT auto-focus on
	// mount: a stray keypress should never silently resolve a permission
	// prompt the user hasn't engaged with yet.

	function onKeyDown(e: KeyboardEvent) {
		if (busy) return;
		if (request.kind !== 'permission') return;
		// Only respond when the dialog root itself is focused. Any nested
		// control (button, input, summary, link) keeps its native key
		// handling — and an untouched dialog stays inert.
		if (e.currentTarget !== e.target) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			pickDeny('deny');
		} else if (e.key === 'Enter' && e.shiftKey) {
			if (!canPersistDecision) return;
			if (denyAllPolicy) return;
			e.preventDefault();
			pickAlways('allow-always');
		} else if (e.key === 'Enter') {
			e.preventDefault();
			pick({ kind: 'permission', decision: 'allow-once' });
		}
	}
</script>

<div class="interactive" role="alertdialog" aria-modal="true" tabindex="-1" onkeydown={onKeyDown}>
	{#if request.kind === 'permission'}
		<div class="head">Permission required</div>
		<div class="body">
			<div>
				<strong>{request.tool}</strong>
				<span class="muted">({request.permissionKind})</span>
			</div>
			<pre>{request.summary}</pre>

			{#if isShellWithAnalysis && shellAnalysis && shellAnalysis.kind === 'parsed'}
				<div class="shell-breakdown" aria-label="Pipeline breakdown">
					<div class="muted small">
						Pipeline ({shellAnalysis.segments.length}
						{shellAnalysis.segments.length === 1 ? 'command' : 'commands'}) — every segment runs if
						you allow this:
					</div>
					<ol class="shell-segments">
						{#each shellAnalysis.segments as seg, i (i)}
							<li>
								<code>{seg.argv.join(' ')}</code>
								{#if seg.followingOp}
									<span class="op" title={operatorGloss(seg.followingOp)}
										><code>{seg.followingOp}</code></span
									>
								{/if}
							</li>
						{/each}
					</ol>
				</div>
			{:else if isShellUnsafe && shellAnalysis && shellAnalysis.kind === 'unsafe'}
				<div class="shell-unsafe" role="note">
					<strong>⚠ Can't analyze this command.</strong>
					<div>
						Reason: <code>{shellAnalysis.reason}</code>. Constructs like subshells, redirection,
						command substitution, or variable expansion can hide arbitrary commands, so structured
						"always" grants won't apply here. Review the full command above before allowing.
					</div>
				</div>
			{/if}

			{#if request.escalationReason}
				<div class="shell-unsafe" role="note">
					<strong>Escalation requested.</strong>
					<div>{request.escalationReason}</div>
					<div class="muted small">
						This request can only be allowed once. Persistent decisions are disabled.
					</div>
				</div>
			{/if}

			{#if formatArgs(request.args)}
				<details class="args">
					<summary>Arguments</summary>
					<pre>{formatArgs(request.args)}</pre>
				</details>
			{/if}

			{#if canPersistDecision}
				<details class="grant-scope">
					<summary>Remember this decision (optional)</summary>
					<div class="scope-body">
						{#if isShellWithAnalysis}
							<fieldset class="scope-group">
								<legend>Persist grants for</legend>
								{#if shellOptions.length === 0}
									<div class="muted small">
										No persistable scopes derivable from this command (all argv[0]s were
										path-qualified or otherwise unsafe to anchor a grant on).
									</div>
								{:else}
									<div class="muted small">
										Check every scope you want to remember. Each becomes its own grant and is
										combined at decision time — covering more invocations than this exact pipeline.
									</div>
									{#each shellOptions as opt (opt.id)}
										<label class="scope-option">
											<input
												type="checkbox"
												checked={!!shellChecked[opt.id]}
												onchange={(e) =>
													(shellChecked[opt.id] = (e.currentTarget as HTMLInputElement).checked)}
											/>
											{opt.label}
										</label>
									{/each}
								{/if}
							</fieldset>
						{:else if isShellUnsafe}
							<div class="muted small">
								Structured grants are unavailable for commands the parser can't model. Use Settings
								→ Permissions to add a coarse "any shell from this tool" grant if you really want
								one.
							</div>
						{:else}
							<fieldset class="scope-group">
								<legend>Scope</legend>
								{#each scopeChoices as choice (choice)}
									{@const c = choice as typeof scopeChoice}
									<label class="scope-option">
										<input
											type="radio"
											name="perm-scope"
											value={c}
											checked={scopeChoice === c}
											disabled={(c === 'this-exact' && !permissionScopeKey) ||
												(c === 'this-directory' && !fsParentDir)}
											onchange={() => (scopeChoice = c)}
										/>
										{scopeOptionLabel(c)}
									</label>
								{/each}
								{#if scopeChoice === 'this-exact' && permissionScopeKey}
									<div class="muted small">
										Matches pattern: <code>{permissionScopeKey}</code>
									</div>
								{:else if scopeChoice === 'this-directory' && fsParentDir}
									<div class="muted small">
										Matches any path resolving inside <code>{fsParentDir}/</code> (symlinks followed).
									</div>
								{/if}
							</fieldset>
						{/if}
						<fieldset class="scope-group">
							<legend>Applies to</legend>
							<label class="scope-option">
								<input
									type="radio"
									name="perm-applies"
									value="this-conversation"
									checked={appliesTo === 'this-conversation'}
									onchange={() => (appliesTo = 'this-conversation')}
								/>
								Just this conversation
							</label>
							<label class="scope-option">
								<input
									type="radio"
									name="perm-applies"
									value="all-conversations"
									checked={appliesTo === 'all-conversations'}
									onchange={() => (appliesTo = 'all-conversations')}
								/>
								Every conversation (global)
							</label>
						</fieldset>
						<label class="expiry">
							Expires:
							<select
								value={expiryChoice}
								onchange={(e) =>
									(expiryChoice = (e.currentTarget as HTMLSelectElement).value as
										| 'forever'
										| '1h'
										| '1d')}
							>
								<option value="forever">Never</option>
								<option value="1h">In 1 hour</option>
								<option value="1d">In 1 day</option>
							</select>
						</label>
					</div>
				</details>
			{/if}
			<label class="deny-feedback">
				<span>Optional feedback if you deny</span>
				<textarea
					bind:value={denialFeedback}
					maxlength="500"
					rows="3"
					disabled={busy}
					placeholder="Tell the agent why this is denied or what to try instead..."
				></textarea>
				<span class="muted small">{denialFeedback.length}/500 characters</span>
			</label>
		</div>
		<div class="actions">
			{#if canPersistDecision}
				<button
					class="btn"
					disabled={busy || (isShellRequest && !isShellWithAnalysis ? false : false)}
					onclick={() => pickAlways('deny-always')}
					title={isShellWithAnalysis
						? previewShellAlways('deny-always')
						: previewAlways('deny-always')}>Deny always</button
				>
			{/if}
			<button class="btn" disabled={busy} onclick={() => pickDeny('deny')} title="Esc">Deny</button>
			<button
				class="btn"
				disabled={busy}
				onclick={() => pick({ kind: 'permission', decision: 'allow-once' })}
				title="Enter">Allow once</button
			>
			{#if canPersistDecision}
				<button
					class="btn primary"
					disabled={busy ||
						denyAllPolicy ||
						isShellUnsafe ||
						(isShellWithAnalysis && shellCheckedCount === 0)}
					onclick={() => pickAlways('allow-always')}
					title={denyAllPolicy
						? 'Your default policy is "Deny all" — change it in Settings before saving Allow grants.'
						: isShellUnsafe
							? 'Structured grants unavailable for unparseable commands. Use "Allow once" or add a grant from Settings.'
							: isShellWithAnalysis && shellCheckedCount === 0
								? 'Check at least one scope above to remember this allow.'
								: `${isShellWithAnalysis ? previewShellAlways('allow-always') : previewAlways('allow-always')}  (Shift+Enter)`}
					>Allow always</button
				>
			{/if}
		</div>
		{#if canPersistDecision}
			<div class="preview muted small" aria-live="polite">
				<span
					><strong>Allow always</strong> → {isShellWithAnalysis
						? previewShellAlways('allow-always')
						: previewAlways('allow-always')}</span
				>
				<span
					><strong>Deny always</strong> → {isShellWithAnalysis
						? previewShellAlways('deny-always')
						: previewAlways('deny-always')}</span
				>
				{#if denyAllPolicy}
					<span class="warning"
						>Default policy is <strong>Deny all</strong>; "Allow always" is disabled so it doesn't
						get silently dropped.</span
					>
				{/if}
			</div>
		{/if}
	{:else if request.kind === 'auto_mode_switch'}
		<div class="head">Switch to auto mode?</div>
		<div class="body">
			<p>
				Copilot hit a rate limit
				{#if request.errorCode}<span class="muted">({request.errorCode})</span>{/if}
				and is offering to switch models so this turn can continue.
				{#if request.retryAfterSeconds}
					<br />Otherwise wait ~{request.retryAfterSeconds}s for the limit to reset.
				{/if}
			</p>
		</div>
		<div class="actions">
			<button
				class="btn"
				disabled={busy}
				onclick={() => pick({ kind: 'auto_mode_switch', decision: 'no' })}>No</button
			>
			<button
				class="btn primary"
				disabled={busy}
				onclick={() => pick({ kind: 'auto_mode_switch', decision: 'yes' })}>Yes, once</button
			>
		</div>
	{:else if request.kind === 'user_input'}
		<div class="head">The agent has a question</div>
		<div class="body">
			<p>{request.question}</p>
			{#if request.choices && request.choices.length > 0}
				<div class="choices">
					{#each request.choices as choice}
						<button
							type="button"
							class="btn"
							disabled={busy}
							onclick={() => pick({ kind: 'user_input', answer: choice, wasFreeform: false })}
							>{choice}</button
						>
					{/each}
				</div>
			{/if}
			{#if request.allowFreeform}
				<form
					onsubmit={(e) => {
						e.preventDefault();
						pick({ kind: 'user_input', answer: userInputAnswer, wasFreeform: true });
					}}
				>
					<input
						type="text"
						bind:value={userInputAnswer}
						placeholder="Your answer..."
						disabled={busy}
					/>
					<button type="submit" class="btn primary" disabled={busy || !userInputAnswer}>Send</button
					>
				</form>
			{/if}
		</div>
	{:else if request.kind === 'elicitation'}
		<div class="head">{request.elicitationSource ?? 'Agent'} needs information</div>
		<div class="body">
			<p>{request.message}</p>
			{#if request.mode === 'url' && request.url}
				<p>
					<a href={request.url} target="_blank" rel="noopener noreferrer">{request.url}</a>
				</p>
				<div class="actions">
					<button
						class="btn"
						disabled={busy}
						onclick={() => pick({ kind: 'elicitation', action: 'decline' })}>Decline</button
					>
					<button
						class="btn primary"
						disabled={busy}
						onclick={() => pick({ kind: 'elicitation', action: 'accept' })}>Done</button
					>
				</div>
			{:else if request.requestedSchema}
				<form
					onsubmit={(e) => {
						e.preventDefault();
						pick({
							kind: 'elicitation',
							action: 'accept',
							content: { ...formValues }
						});
					}}
				>
					{#each Object.entries(request.requestedSchema.properties) as [name, field] (name)}
						<label class="field">
							<span class="label">{fieldLabel(name, field)}</span>
							{#if field.description}<small class="muted">{field.description}</small>{/if}
							{#if field.type === 'boolean'}
								<input
									type="checkbox"
									checked={Boolean(formValues[name])}
									onchange={(e) =>
										(formValues[name] = (e.currentTarget as HTMLInputElement).checked)}
								/>
							{:else if field.type === 'string' && field.enum}
								<select
									value={String(formValues[name] ?? '')}
									onchange={(e) =>
										(formValues[name] = (e.currentTarget as HTMLSelectElement).value)}
								>
									{#each field.enum as opt, i}
										<option value={opt}>{field.enumNames?.[i] ?? opt}</option>
									{/each}
								</select>
							{:else if field.type === 'string'}
								<input
									type="text"
									value={String(formValues[name] ?? '')}
									oninput={(e) => (formValues[name] = (e.currentTarget as HTMLInputElement).value)}
								/>
							{:else if field.type === 'number' || field.type === 'integer'}
								<input
									type="number"
									value={Number(formValues[name] ?? 0)}
									oninput={(e) =>
										(formValues[name] = Number((e.currentTarget as HTMLInputElement).value))}
								/>
							{:else}
								<input
									type="text"
									value={String(formValues[name] ?? '')}
									oninput={(e) => (formValues[name] = (e.currentTarget as HTMLInputElement).value)}
								/>
							{/if}
						</label>
					{/each}
					<div class="actions">
						<button
							type="button"
							class="btn"
							disabled={busy}
							onclick={() => pick({ kind: 'elicitation', action: 'cancel' })}>Cancel</button
						>
						<button
							type="button"
							class="btn"
							disabled={busy}
							onclick={() => pick({ kind: 'elicitation', action: 'decline' })}>Decline</button
						>
						<button type="submit" class="btn primary" disabled={busy}>Submit</button>
					</div>
				</form>
			{:else}
				<div class="actions">
					<button
						class="btn"
						disabled={busy}
						onclick={() => pick({ kind: 'elicitation', action: 'decline' })}>Decline</button
					>
					<button
						class="btn primary"
						disabled={busy}
						onclick={() => pick({ kind: 'elicitation', action: 'accept' })}>Accept</button
					>
				</div>
			{/if}
		</div>
	{:else if request.kind === 'exit_plan_mode'}
		<div class="head">Ready to exit plan mode?</div>
		<div class="body">
			<p>{request.summary}</p>
			{#if request.planContent}<pre>{request.planContent}</pre>{/if}
		</div>
		<div class="actions">
			<button
				class="btn"
				disabled={busy}
				onclick={() => pick({ kind: 'exit_plan_mode', approved: false })}>Stay in plan mode</button
			>
			{#each request.actions as action}
				<button
					class="btn"
					class:primary={action === request.recommendedAction}
					disabled={busy}
					onclick={() => pick({ kind: 'exit_plan_mode', approved: true, selectedAction: action })}
					>{action}</button
				>
			{/each}
		</div>
	{:else if request.kind === 'sampling'}
		<div class="head">MCP sampling request</div>
		<div class="body">
			<p>{request.summary}</p>
		</div>
		<div class="actions">
			<button class="btn" disabled={busy} onclick={() => pick({ kind: 'sampling', action: 'ack' })}
				>Dismiss</button
			>
		</div>
	{:else if request.kind === 'mcp_oauth'}
		<div class="head">MCP server authentication</div>
		<div class="body">
			<p>{request.summary}</p>
			{#if request.authorizationUrl}
				<p>
					<a href={request.authorizationUrl} target="_blank" rel="noopener noreferrer"
						>Open authorization URL</a
					>
				</p>
			{/if}
		</div>
		<div class="actions">
			<button class="btn" disabled={busy} onclick={() => pick({ kind: 'mcp_oauth', action: 'ack' })}
				>Dismiss</button
			>
		</div>
	{:else if request.kind === 'external_tool'}
		<div class="head">External tool: {request.toolName}</div>
		<div class="body">
			<p>{request.summary}</p>
		</div>
		<div class="actions">
			<button
				class="btn"
				disabled={busy}
				onclick={() => pick({ kind: 'external_tool', action: 'ack' })}>Dismiss</button
			>
		</div>
	{/if}
</div>

<style>
	.interactive {
		border: 1px solid var(--warning);
		background: var(--warning-bg);
		border-radius: var(--radius-lg);
		padding: var(--space-3) var(--space-4);
	}
	.head {
		font-weight: 600;
		margin-bottom: 0.4rem;
	}
	.body pre {
		background: var(--surface);
		max-height: 200px;
		overflow: auto;
		margin-top: 0.4rem;
		font-size: 0.85em;
	}
	.body details.args {
		margin-top: 0.4rem;
		font-size: 0.85em;
	}
	.body details.args > summary {
		cursor: pointer;
		opacity: 0.8;
	}
	.body details.args pre {
		margin-top: 0.3rem;
		max-height: 240px;
	}
	.body details.grant-scope {
		margin-top: 0.6rem;
		padding: 0.4rem 0.5rem;
		border: 1px dashed var(--border);
		border-radius: var(--radius-sm);
		font-size: 0.85em;
	}
	.body details.grant-scope > summary {
		cursor: pointer;
		opacity: 0.85;
	}
	.scope-body {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}
	.scope-group {
		border: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.scope-group legend {
		font-weight: 600;
		padding: 0 0 0.2rem;
	}
	.scope-option {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-weight: normal;
	}
	.scope-option:has(input[type='radio']:disabled) {
		opacity: 0.5;
	}
	.shell-breakdown {
		margin-top: 0.5rem;
		padding: 0.4rem 0.5rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		font-size: 0.85em;
	}
	.shell-segments {
		margin: 0.3rem 0 0;
		padding-left: 1.3rem;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	.shell-segments li {
		line-height: 1.4;
	}
	.shell-segments code {
		font-size: 0.95em;
	}
	.shell-segments .op {
		margin-left: 0.4rem;
		opacity: 0.75;
		font-size: 0.85em;
	}
	.shell-unsafe {
		margin-top: 0.5rem;
		padding: 0.4rem 0.5rem;
		border: 1px solid var(--danger, var(--warning));
		background: var(--danger-bg, var(--warning-bg));
		border-radius: var(--radius-sm);
		font-size: 0.85em;
	}
	.shell-unsafe strong {
		display: block;
		margin-bottom: 0.2rem;
	}
	.expiry {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.expiry select {
		padding: 0.2rem 0.4rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: inherit;
	}
	.deny-feedback {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin-top: 0.6rem;
		font-size: 0.85em;
	}
	.deny-feedback span:first-child {
		font-weight: 600;
	}
	.deny-feedback textarea {
		width: 100%;
		box-sizing: border-box;
		resize: vertical;
		padding: 0.35rem 0.5rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: inherit;
		font: inherit;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.6rem;
		justify-content: flex-end;
		flex-wrap: wrap;
	}
	.preview {
		margin-top: 0.4rem;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		font-size: 0.8em;
		line-height: 1.35;
	}
	.preview .warning {
		color: var(--danger);
	}
	.choices {
		display: flex;
		gap: 0.4rem;
		margin: 0.4rem 0;
		flex-wrap: wrap;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		margin: 0.5rem 0;
	}
	.field .label {
		font-weight: 500;
		font-size: 0.9em;
	}
	form input[type='text'],
	form input[type='number'],
	form select {
		padding: 0.3rem 0.5rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: inherit;
	}
</style>
