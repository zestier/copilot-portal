// "Edit earlier message" → fork-conversation service.
//
// Forking creates a NEW conversation seeded with the prefix of messages
// up to (but not including) the edited message, plus the edited user
// message as a fresh row. The new conversation gets a fresh workdir
// materialised from the pre-snapshot of the edited message — so the
// agent picks up exactly the file state the original conversation had
// when that message was first sent.
//
// The original conversation is left untouched. This is deliberately
// non-destructive: the user can always navigate back to the source
// thread.
//
// Two flavours:
//  1. EDIT  — target is a user message, `newContent` is the replacement
//             text. Uses the `pre` snapshot (workdir state before that
//             user turn ran). The clone includes everything *strictly
//             before* the edited message, and the edited message is
//             appended as a fresh user row.
//  2. RETRY — target is an assistant message, `newContent` is null.
//             Uses the `post` snapshot (workdir state after that
//             assistant turn finished). The clone includes everything
//             *up to and including* the target assistant message, and
//             no new user message is appended — the user types their
//             next prompt themselves in the new conversation.
//
// Constraints:
//  - System messages can never be the fork target.
//  - The source conversation's workdir must be portal-managed (under
//    DATA_DIR/workspaces/). Forking a bring-your-own workdir is rejected
//    in v1 — duplicating an arbitrary user-supplied directory is
//    surprising and may have unbounded cost.
//  - A pre-snapshot must exist for the target message. If snapshotting
//    failed at the time the message was sent (very rare, but logged),
//    the fork is rejected with a clear error rather than silently
//    forking into a possibly-wrong tree state.
//  - The source conversation must not have a running turn (the workdir
//    might be mid-mutation and the source's git index is in flux).

import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { ulid } from './db/ids';
import { getDb } from './db';
import { loadConfig } from './config';
import * as convs from './db/repos/conversations';
import * as messages from './db/repos/messages';
import { getSnapshot, materializeFromCommit } from './snapshots';
import { getTurn } from './copilot/turn-runner';
import { log } from './log';
import type { Conversation, Message } from '$lib/types';

export type ForkError =
	| 'source_not_found'
	| 'message_not_found'
	| 'not_user_message'
	| 'unsupported_role'
	| 'content_required'
	| 'content_not_allowed'
	| 'source_busy'
	| 'no_snapshot'
	| 'unsupported_workdir';

export class ForkRejected extends Error {
	constructor(
		public readonly reason: ForkError,
		msg?: string
	) {
		super(msg ?? reason);
		this.name = 'ForkRejected';
	}
}

export interface ForkInput {
	userId: string;
	sourceConversationId: string;
	messageId: string;
	/**
	 * The replacement text for a user-message edit. Must be null/undefined
	 * for an assistant-message retry.
	 */
	newContent: string | null;
}

export interface ForkResult {
	conversation: Conversation;
}

function managedWorkspacesRoot(): string {
	const cfg = loadConfig();
	const dir = resolve(cfg.DATA_DIR, 'workspaces');
	try {
		return realpathSync(dir);
	} catch {
		return dir;
	}
}

function isManagedWorkdir(workdir: string): boolean {
	let real: string;
	try {
		real = realpathSync(workdir);
	} catch {
		real = resolve(workdir);
	}
	const root = managedWorkspacesRoot();
	return real === root || real.startsWith(root + '/');
}

/**
 * Edit `messageId` (a user message in `sourceConversationId`) and produce
 * a new forked conversation seeded with prior history + the edit, with
 * a freshly materialised workdir at the message's pre-snapshot.
 */
export async function forkAtMessage(input: ForkInput): Promise<ForkResult> {
	const source = convs.get(input.sourceConversationId, input.userId);
	if (!source) throw new ForkRejected('source_not_found');

	const all = messages.listByConversation(source.id);
	const targetIdx = all.findIndex((m) => m.id === input.messageId);
	if (targetIdx < 0) throw new ForkRejected('message_not_found');
	const target = all[targetIdx];

	// Decide flavour from the target's role; validate inputs against it.
	let mode: 'edit' | 'retry';
	if (target.role === 'user') {
		if (input.newContent == null || input.newContent === '') {
			throw new ForkRejected(
				'content_required',
				'newContent is required when editing a user message.'
			);
		}
		mode = 'edit';
	} else if (target.role === 'assistant') {
		if (input.newContent != null) {
			throw new ForkRejected(
				'content_not_allowed',
				'newContent must be omitted when retrying an assistant message.'
			);
		}
		// Don't let the user retry from a half-finished assistant turn —
		// the post-snapshot for that message won't exist yet anyway, but
		// fail loudly instead of confusing the user with a no_snapshot.
		if (target.status !== 'complete') {
			throw new ForkRejected(
				'unsupported_role',
				'Can only retry from a completed assistant message.'
			);
		}
		mode = 'retry';
	} else {
		throw new ForkRejected('unsupported_role', `Cannot fork from a ${target.role} message.`);
	}

	const active = getTurn(source.id);
	if (active && active.status === 'running') {
		throw new ForkRejected('source_busy', 'Source conversation has a running turn.');
	}

	const snapKind = mode === 'edit' ? 'pre' : 'post';
	const snap = getSnapshot(target.id, snapKind);
	if (!snap) {
		throw new ForkRejected(
			'no_snapshot',
			`No ${snapKind}-snapshot was captured for this message; cannot fork.`
		);
	}

	if (!isManagedWorkdir(source.workdir)) {
		throw new ForkRejected(
			'unsupported_workdir',
			'Forking is only supported for portal-managed workdirs in this version.'
		);
	}

	// Mint the new conversation id up front so we can derive its workdir
	// path before inserting the row (matches defaultWorkdirFor()'s layout).
	const cfg = loadConfig();
	const newId = convs.newId();
	const newWorkdir = resolve(cfg.DATA_DIR, 'workspaces', newId);

	try {
		await materializeFromCommit(source.workdir, snap.commitSha, newWorkdir);
	} catch (e) {
		log.warn('fork.materialize_failed', {
			source: source.id,
			messageId: target.id,
			err: String(e)
		});
		throw e;
	}

	const newConv = convs.create(input.userId, {
		id: newId,
		title: source.title,
		workdir: newWorkdir,
		model: source.model,
		forkedFromConversationId: source.id,
		forkedFromMessageId: target.id
	});

	// Edit mode clones strictly before the target (so the new user message
	// replaces it). Retry mode clones up to AND including the target
	// assistant message (so its reply is preserved as context, and the
	// user picks up by typing the next prompt).
	const prefixEnd = mode === 'edit' ? targetIdx : targetIdx + 1;
	const prefix = all.slice(0, prefixEnd);
	cloneMessagePrefix(newConv.id, prefix);
	if (mode === 'edit') {
		messages.append(newConv.id, { role: 'user', content: input.newContent! });
	}

	const refreshed = convs.get(newConv.id, input.userId);
	if (!refreshed) throw new Error('fork: created conversation disappeared');
	log.info('fork.created', {
		mode,
		source: source.id,
		newId: newConv.id,
		messageId: target.id,
		prefix: prefix.length
	});
	return { conversation: refreshed };
}

function cloneMessagePrefix(targetConvId: string, prefix: Message[]) {
	const db = getDb();
	const baseTs = Date.now() - prefix.length - 1;
	const insertMsg = db.prepare(
		`INSERT INTO messages(id, conversation_id, role, content, status, error_code, created_at, reasoning, reasoning_duration_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const insertTool = db.prepare(
		`INSERT INTO tool_calls(id, message_id, tool, args_json, result_json, status, started_at, ended_at, text_offset)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const insertEdit = db.prepare(
		`INSERT INTO file_edits(id, message_id, path, diff, created_at, text_offset)
		 VALUES (?, ?, ?, ?, ?, ?)`
	);
	const tx = db.transaction(() => {
		prefix.forEach((m, i) => {
			const newId = ulid();
			const ts = baseTs + i;
			insertMsg.run(
				newId,
				targetConvId,
				m.role,
				m.content,
				m.status,
				m.errorCode,
				ts,
				m.reasoning ?? null,
				m.reasoningDurationMs ?? null
			);
			for (const t of m.toolCalls ?? []) {
				insertTool.run(
					ulid(),
					newId,
					t.tool,
					t.argsJson,
					t.resultJson,
					t.status,
					t.startedAt,
					t.endedAt,
					t.textOffset
				);
			}
			for (const e of m.fileEdits ?? []) {
				insertEdit.run(ulid(), newId, e.path, e.diff, ts, e.textOffset);
			}
		});
	});
	tx();
}
