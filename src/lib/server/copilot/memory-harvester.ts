import { z } from 'zod';
import { ulid } from '../db/ids';
import * as convs from '../db/repos/conversations';
import * as memory from '../db/repos/memory';
import * as messages from '../db/repos/messages';
import { appGlobalSymbols, getOrCreateGlobalSingleton } from '../global-singleton';
import { log } from '../log';
import { deleteProviderSession, open, type ProviderOpenOptions } from '../providers';
import { isStubMode } from './bridge-stub';
import { memorySupportsHarvester, type MemoryHarvestRecord } from '$lib/types';

const MIN_ASSISTANT_CHARS = 200;
const HARVEST_TIMEOUT_MS = 120_000;

const HarvestWrite = z
	.object({
		scope: z.enum(['scene', 'session']).optional().default('session'),
		kind: z.string().trim().min(1).max(80),
		entity: z.string().trim().min(1).max(200).optional(),
		content: z
			.unknown()
			.refine(memory.isMemoryContent, 'Content must be a JSON-compatible value')
			.refine(memory.isMemoryContentWithinLimit, 'Content is too large'),
		tags: z.array(z.string().trim().min(1).max(100)).max(20).optional().default([]),
		importance: z.number().int().min(1).max(5).optional().default(3)
	})
	.strict();

const HarvestUpdate = z
	.object({
		entity: z.string().trim().min(1).max(200),
		scope: z.enum(['scene', 'session']).optional(),
		kind: z.string().trim().min(1).max(80).optional(),
		content: z
			.unknown()
			.refine(memory.isMemoryContent, 'Content must be a JSON-compatible value')
			.refine(memory.isMemoryContentWithinLimit, 'Content is too large')
			.optional(),
		tags: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
		importance: z.number().int().min(1).max(5).optional()
	})
	.strict();

const HarvestForget = z
	.object({
		entity: z.string().trim().min(1).max(200),
		scope: z.enum(['scene', 'session']).optional()
	})
	.strict();

const HarvestPayload = z
	.object({
		writes: z.array(HarvestWrite).optional().default([]),
		updates: z.array(HarvestUpdate).optional().default([]),
		forgets: z.array(HarvestForget).optional().default([]),
		scene_end: z.boolean().optional().default(false)
	})
	.strict();

interface HarvestChange {
	action: 'write' | 'update' | 'forget' | 'scene_end';
	status: 'applied' | 'skipped';
	reason?: string;
	memoryId?: string;
	requested?: unknown;
	before?: MemorySnapshot;
	after?: MemorySnapshot;
	archived?: number;
}

interface MemorySnapshot {
	id: string;
	scope: memory.MemoryScope;
	kind: string;
	entity: string | null;
	content: memory.MemoryContent;
	tags: string[];
	importance: number;
	status: memory.MemoryStatus;
	source: memory.MemorySource;
	updatedAt: number;
}

export interface ScheduleHarvestInput {
	bridge: ProviderOpenOptions;
	assistantMessageId: string;
	userPrompt: string;
	assistantReply: string;
	onUpdate?: (harvest: MemoryHarvestRecord) => void;
	// Runs once the harvest pass has settled (applied, empty, skipped, or
	// failed) and any memory-bank mutations are committed. Used by the turn
	// runner to take the post-turn memory snapshot only after the harvest's
	// writes land, while keeping the visible turn non-blocking. On the
	// synchronous skip path it runs inline before scheduleHarvest returns.
	onSettled?: () => void;
}

export interface ScheduledHarvest {
	initial: MemoryHarvestRecord;
	finished: Promise<void>;
}

const CHAIN_KEYS = appGlobalSymbols('memory.harvester.chains');
const chains: Map<string, Promise<void>> = getOrCreateGlobalSingleton(CHAIN_KEYS, () => new Map());

export function scheduleHarvest(input: ScheduleHarvestInput): ScheduledHarvest | null {
	if (isStubMode()) return null;
	if (!memorySupportsHarvester(input.bridge.memoryLevel)) return null;
	if (input.assistantReply.trim().length < MIN_ASSISTANT_CHARS) {
		const initial = recordHarvest(input, {
			status: 'skipped',
			reason: 'assistant_reply_too_short',
			changesJson: stringifyDiagnostic([
				{
					action: 'write',
					status: 'skipped',
					reason: 'assistant_reply_too_short'
				}
			])
		});
		// No harvest pass runs, but the model may still have mutated the bank
		// via memory tools this turn, so settle (snapshot) synchronously.
		runSettle(input);
		return initial ? { initial, finished: Promise.resolve() } : null;
	}
	const initial = recordHarvest(input, { status: 'pending' });
	if (!initial) return null;
	const previous = chains.get(input.bridge.conversationId) ?? Promise.resolve();
	const next = previous
		.catch(() => undefined)
		.then(() => harvest(input))
		.catch((err) => {
			recordHarvest(input, {
				status: 'failed',
				reason: 'exception',
				error: err instanceof Error ? (err.stack ?? err.message) : String(err)
			});
			log.warn('memory.harvest.failed', {
				conversationId: input.bridge.conversationId,
				messageId: input.assistantMessageId,
				err: err instanceof Error ? (err.stack ?? err.message) : String(err)
			});
		})
		.then(() => runSettle(input));
	const tracked = next.finally(() => {
		if (chains.get(input.bridge.conversationId) === tracked)
			chains.delete(input.bridge.conversationId);
	});
	chains.set(input.bridge.conversationId, tracked);
	return { initial, finished: tracked };
}

// Run the caller's post-harvest settle hook (e.g. snapshotting), isolating
// its failures so they never reject the harvest chain that the next turn
// waits on.
function runSettle(input: ScheduleHarvestInput): void {
	try {
		input.onSettled?.();
	} catch (err) {
		log.warn('memory.harvest.settle_failed', {
			conversationId: input.bridge.conversationId,
			messageId: input.assistantMessageId,
			err: err instanceof Error ? (err.stack ?? err.message) : String(err)
		});
	}
}

function recordHarvest(
	input: ScheduleHarvestInput,
	harvest: messages.MemoryHarvestUpsert
): MemoryHarvestRecord | null {
	try {
		const record = messages.upsertMemoryHarvest(input.assistantMessageId, harvest);
		input.onUpdate?.(record);
		return record;
	} catch (err) {
		log.warn('memory.harvest.status_persist_failed', {
			conversationId: input.bridge.conversationId,
			messageId: input.assistantMessageId,
			err: err instanceof Error ? (err.stack ?? err.message) : String(err)
		});
		return null;
	}
}

// Resolve once any in-progress background harvest (and its post-harvest
// settle/snapshot) for the conversation has completed. The next turn awaits
// this before reading the injected memory digest so it reflects the harvested
// state and doesn't race the prior turn's snapshot. Resolves immediately when
// nothing is pending.
export async function waitForPendingHarvest(conversationId: string): Promise<void> {
	await chains.get(conversationId);
}

export async function waitForHarvestsForTests(conversationId: string): Promise<void> {
	await waitForPendingHarvest(conversationId);
}

async function harvest(input: ScheduleHarvestInput): Promise<void> {
	const conversationId = input.bridge.conversationId;
	const startedAt = Date.now();
	const prompt = buildHarvestPrompt(
		input.bridge.userId,
		conversationId,
		redactSensitiveText(input.userPrompt),
		redactSensitiveText(input.assistantReply)
	);
	const harvestConversationId = ulid();
	const session = await open({
		...input.bridge,
		conversationId: harvestConversationId,
		providerSessionId: harvestConversationId,
		initialMessages: [],
		approveAllTools: false,
		disableTools: true
	});
	const ac = new AbortController();
	const timeout = setTimeout(() => ac.abort(), HARVEST_TIMEOUT_MS);
	(timeout as { unref?: () => void }).unref?.();
	let response = '';
	let reasoning = '';
	try {
		for await (const ev of session.send(prompt, ac.signal)) {
			if (ev.type === 'message.delta') response += ev.text;
			else if (ev.type === 'message.reasoning') reasoning += ev.text;
		}
	} finally {
		clearTimeout(timeout);
		await disposeHarvestSession(input, session, harvestConversationId);
	}
	const parsedJson = extractJson(response);
	if (!parsedJson) {
		recordHarvest(input, {
			status: 'failed',
			reason: 'missing_json',
			error: response.trim().slice(0, 1000) || null,
			prompt,
			response,
			reasoning: reasoning || null
		});
		log.warn('memory.harvest.parse_failed', { conversationId, reason: 'missing_json' });
		return;
	}
	const parsed = HarvestPayload.safeParse(parsedJson);
	if (!parsed.success) {
		recordHarvest(input, {
			status: 'failed',
			reason: 'invalid_json_shape',
			error: parsed.error.message,
			prompt,
			response,
			reasoning: reasoning || null,
			parsedJson: stringifyDiagnostic(parsedJson)
		});
		log.warn('memory.harvest.parse_failed', {
			conversationId,
			reason: parsed.error.message
		});
		return;
	}
	const result = applyHarvest(input.bridge, parsed.data, startedAt);
	const changed = result.writes + result.updates + result.forgets + (result.sceneEnded ? 1 : 0);
	recordHarvest(input, {
		status: changed > 0 ? 'applied' : 'empty',
		reason: changed > 0 ? null : 'no_changes',
		writes: result.writes,
		updates: result.updates,
		forgets: result.forgets,
		sceneEnded: result.sceneEnded,
		prompt,
		response,
		reasoning: reasoning || null,
		parsedJson: stringifyDiagnostic(parsed.data),
		changesJson: stringifyDiagnostic(result.changes)
	});
}

async function disposeHarvestSession(
	input: ScheduleHarvestInput,
	session: { dispose(): Promise<void> },
	providerSessionId: string
): Promise<void> {
	const conversationId = input.bridge.conversationId;
	try {
		await session.dispose();
	} catch (e) {
		log.warn('memory.harvest.session_dispose_failed', {
			conversationId,
			providerSessionId,
			err: String(e)
		});
		throw e;
	} finally {
		try {
			await deleteProviderSession(input.bridge.provider, {
				userId: input.bridge.userId,
				providerSessionId,
				providerAuthToken: input.bridge.providerAuthToken
			});
		} catch (e) {
			log.warn('memory.harvest.session_delete_failed', {
				conversationId,
				providerSessionId,
				err: String(e)
			});
		}
	}
}

function applyHarvest(
	bridge: ProviderOpenOptions,
	payload: z.infer<typeof HarvestPayload>,
	startedAt: number
): {
	writes: number;
	updates: number;
	forgets: number;
	sceneEnded: boolean;
	changes: HarvestChange[];
} {
	const result: {
		writes: number;
		updates: number;
		forgets: number;
		sceneEnded: boolean;
		changes: HarvestChange[];
	} = {
		writes: 0,
		updates: 0,
		forgets: 0,
		sceneEnded: false,
		changes: []
	};
	const conversationId = bridge.conversationId;
	if (!convs.get(conversationId, bridge.userId)) {
		result.changes.push({
			action: 'write',
			status: 'skipped',
			reason: 'conversation_not_found_or_not_owned'
		});
		return result;
	}
	for (const item of payload.writes) {
		const entity = item.entity?.trim() || null;
		const existing = entity
			? memory.resolveActive(bridge.userId, conversationId, entity, item.scope)
			: null;
		// An entity-keyed write upserts in place. Guard the same way updates do:
		// don't clobber a memory the user changed after this pass started.
		if (existing && existing.updatedAt > startedAt) {
			result.changes.push({
				action: 'write',
				status: 'skipped',
				reason: 'memory_changed_after_harvest_started',
				memoryId: existing.id,
				requested: item,
				before: snapshotMemory(existing)
			});
			continue;
		}
		const written = memory.write(bridge.userId, conversationId, {
			scope: item.scope,
			kind: item.kind,
			entity,
			content: item.content,
			tags: item.tags,
			importance: item.importance,
			source: 'harvester'
		});
		const isNew = !existing;
		if (isNew) result.writes += 1;
		else result.updates += 1;
		result.changes.push({
			action: 'write',
			status: 'applied',
			reason: isNew ? undefined : 'refined_existing_entity',
			memoryId: written.id,
			requested: item,
			before: existing ? snapshotMemory(existing) : undefined,
			after: snapshotMemory(written)
		});
	}
	for (const item of payload.updates) {
		const current = resolveHarvestTarget(bridge, conversationId, item.entity, item.scope);
		if (!current.row) {
			result.changes.push({
				action: 'update',
				status: 'skipped',
				reason: current.reason,
				requested: item
			});
			continue;
		}
		const before = snapshotMemory(current.row);
		if (current.row.updatedAt > startedAt) {
			result.changes.push({
				action: 'update',
				status: 'skipped',
				reason: 'memory_changed_after_harvest_started',
				memoryId: current.row.id,
				requested: item,
				before
			});
			continue;
		}
		const updated = memory.update(current.row.id, bridge.userId, conversationId, {
			kind: item.kind,
			content: item.content,
			tags: item.tags,
			importance: item.importance
		});
		if (updated) result.updates += 1;
		result.changes.push({
			action: 'update',
			status: updated ? 'applied' : 'skipped',
			reason: updated ? undefined : 'update_failed',
			memoryId: current.row.id,
			requested: item,
			before,
			after: updated ? snapshotMemory(updated) : undefined
		});
	}
	for (const item of payload.forgets) {
		const current = resolveHarvestTarget(bridge, conversationId, item.entity, item.scope);
		if (!current.row) {
			result.changes.push({
				action: 'forget',
				status: 'skipped',
				reason: current.reason,
				requested: item
			});
			continue;
		}
		const before = snapshotMemory(current.row);
		if (current.row.updatedAt > startedAt) {
			result.changes.push({
				action: 'forget',
				status: 'skipped',
				reason: 'memory_changed_after_harvest_started',
				memoryId: current.row.id,
				requested: item,
				before
			});
			continue;
		}
		const forgotten = memory.forget(current.row.id, bridge.userId, conversationId);
		if (forgotten) result.forgets += 1;
		result.changes.push({
			action: 'forget',
			status: forgotten ? 'applied' : 'skipped',
			reason: forgotten ? undefined : 'forget_failed',
			memoryId: current.row.id,
			requested: item,
			before,
			after: forgotten
				? snapshotMemory(memory.get(current.row.id, bridge.userId, conversationId) ?? current.row)
				: undefined
		});
	}
	if (payload.scene_end) {
		const closed = memory.closeScene(bridge.userId, conversationId);
		result.sceneEnded = closed !== null;
		result.changes.push({
			action: 'scene_end',
			status: closed ? 'applied' : 'skipped',
			reason: closed ? undefined : 'no_active_scene',
			archived: closed?.archived
		});
	}
	return result;
}

function resolveHarvestTarget(
	bridge: ProviderOpenOptions,
	conversationId: string,
	entity: string,
	scope?: memory.WritableMemoryScope
): { row: memory.MemoryRow | null; reason?: string } {
	try {
		const row = memory.resolveActive(bridge.userId, conversationId, entity, scope);
		return { row, reason: row ? undefined : 'memory_not_found_or_not_owned' };
	} catch {
		// resolveActive throws when a handle is active in more than one scope and
		// no scope was supplied to disambiguate.
		return { row: null, reason: 'ambiguous_entity_requires_scope' };
	}
}

function snapshotMemory(row: memory.MemoryRow): MemorySnapshot {
	return {
		id: row.id,
		scope: row.scope,
		kind: row.kind,
		entity: row.entity,
		content: row.content,
		tags: row.tags,
		importance: row.importance,
		status: row.status,
		source: row.source,
		updatedAt: row.updatedAt
	};
}

function stringifyDiagnostic(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function buildHarvestPrompt(
	userId: string,
	conversationId: string,
	userPrompt: string,
	assistantReply: string
): string {
	const existing = memory
		.getActiveDigest(userId, conversationId, 6000)
		.map((row) => {
			const tags = row.tags.length ? ` tags=${JSON.stringify(row.tags)}` : '';
			const entity = ` entity=${JSON.stringify(row.entity)}`;
			return `- scope=${row.scope}${entity} updatedAt=${row.updatedAt} kind=${row.kind} source=${row.source} importance=${row.importance}${tags} content=${JSON.stringify(row.content)}`;
		})
		.join('\n');
	return [
		'You are a memory-bank maintenance pass for an AI assistant conversation.',
		'Extract and maintain only durable continuity records that would help the assistant stay consistent later.',
		'Each memory is a typed structured record with a required kind, scope, entity handle, and native JSON content.',
		...memory.MEMORY_ENTITY_GUIDANCE,
		'There are no numeric ids: address existing memories by their entity handle (and scope when a handle is active in both a scene and the session).',
		'Prefer refining or forgetting existing entity handles instead of creating near-duplicates under reworded handles.',
		'Actively compact bloated memories into small structured JSON records when meaning can be preserved.',
		'Use kind as the mutable record category, e.g. character, worldbuilding, plot_thread, relationship, scene_state, continuity, style, foreshadowing, bugfix, command, architecture, decision, handoff, integration, preference.',
		'Use entity as a stable dot-path key such as story.protagonist.mara, story.plot.thread.vanished_city, user.memory.style, or repo.commands.validation.',
		'Use content as native JSON, not a JSON string. Prefer compact objects for coupled fields and scalar values for simple facts.',
		'For storytelling, preserve dramatic utility: character wants/fears/voice, world rules, active plot questions, relationship tensions, current scene state, continuity objects, style constraints, and foreshadowing plans.',
		'Correct existing memories when the latest conversation clarifies, narrows, or invalidates them; preserve important qualifiers such as currently, usually, prefers, unless, and repo/session scope.',
		'You may rewrite verbose direct-agent memories (source=model) even if the latest turn only reveals that they are bloated, redundant, stale, or mixed-topic.',
		'To split a mixed-topic memory, update the existing handle to one concise keyed fact, write the other durable facts under distinct honest handles, and forget any active duplicate left behind.',
		'Prefer structured key/value records over narrative summaries. Do not make memories so terse that meaning, actor, or qualifier is lost.',
		'Use active memories about memory or harvesting preferences as criteria for this maintenance pass when they fit these rules.',
		'Do not record secrets, credentials, private keys, or irrelevant implementation details.',
		'Respond ONLY with a JSON object matching this TypeScript shape:',
		'{"writes":[{"scope":"scene|session","kind":"character|plot_thread|scene_state|style|bugfix|...","entity":"dot.path.key","content":{"native":"json"},"tags":["tag"],"importance":1}],"updates":[{"entity":"dot.path.key","scope":"scene|session","kind":"replacement_kind","content":{"replacement":"native json"},"importance":3}],"forgets":[{"entity":"dot.path.key","scope":"scene|session"}],"scene_end":false}',
		'In writes, entity is optional and a handle will be generated when omitted; in updates and forgets, entity is required and identifies the target. scope is optional and only disambiguates a handle used in both a scene and the session.',
		'Use scope="scene" for short-lived situational state and scope="session" for facts useful across the conversation.',
		'If there is nothing to change, respond with {"writes":[],"updates":[],"forgets":[],"scene_end":false}.',
		'',
		'Existing active memories:',
		existing || '(none)',
		'',
		'Latest user message:',
		userPrompt,
		'',
		'Latest assistant reply:',
		assistantReply
	].join('\n');
}

function extractJson(response: string): unknown | null {
	const trimmed = response.trim();
	if (!trimmed) return null;
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const raw = fenced ? fenced[1].trim() : trimmed;
	try {
		return JSON.parse(raw);
	} catch {
		const start = raw.indexOf('{');
		const end = raw.lastIndexOf('}');
		if (start < 0 || end <= start) return null;
		try {
			return JSON.parse(raw.slice(start, end + 1));
		} catch {
			return null;
		}
	}
}

function redactSensitiveText(text: string): string {
	return text
		.replace(/(gh[pousr]_[A-Za-z0-9_]{20,})/g, '[REDACTED_GITHUB_TOKEN]')
		.replace(/(sk-[A-Za-z0-9_-]{20,})/g, '[REDACTED_API_KEY]')
		.replace(
			/(-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/g,
			'[REDACTED_PRIVATE_KEY]'
		)
		.replace(
			/(\b(?:password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*)([^\s]+)/gi,
			'$1[REDACTED]'
		);
}
