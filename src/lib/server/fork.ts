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
// Constraints:
//  - Only user messages can be edited. Forking from an assistant message
//    has no obvious "edit" semantics (you'd be putting words in the
//    agent's mouth).
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
	newContent: string;
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
	if (target.role !== 'user') {
		throw new ForkRejected('not_user_message', 'Only user messages can be edited and re-run.');
	}

	const active = getTurn(source.id);
	if (active && active.status === 'running') {
		throw new ForkRejected('source_busy', 'Source conversation has a running turn.');
	}

	const snap = getSnapshot(target.id, 'pre');
	if (!snap) {
		throw new ForkRejected(
			'no_snapshot',
			'No workdir snapshot was captured for this message; cannot fork.'
		);
	}

	if (!isManagedWorkdir(source.workdir)) {
		throw new ForkRejected(
			'unsupported_workdir',
			'Forking is only supported for portal-managed workdirs in this version.'
		);
	}

	// Build the new conversation row + workdir path. We create the row
	// first so we can derive the workdir path from its id, matching the
	// convention used by defaultWorkdirFor().
	const cfg = loadConfig();
	const newConv = convs.create(input.userId, {
		title: source.title,
		workdir: '', // filled below
		model: source.model,
		forkedFromConversationId: source.id,
		forkedFromMessageId: target.id
	});
	const newWorkdir = resolve(cfg.DATA_DIR, 'workspaces', newConv.id);

	try {
		await materializeFromCommit(source.workdir, snap.commitSha, newWorkdir);
	} catch (e) {
		// Roll back the conversation row so we don't leak a half-created
		// fork on disk failure.
		try {
			convs.remove(newConv.id, input.userId);
		} catch (rmErr) {
			log.warn('fork.rollback.remove_failed', { newId: newConv.id, err: String(rmErr) });
		}
		log.warn('fork.materialize_failed', {
			source: source.id,
			messageId: target.id,
			err: String(e)
		});
		throw e;
	}

	// Patch the workdir column to the actual path now that the directory
	// exists. We do this directly because the conversations repo has no
	// dedicated setter for workdir (it's normally write-once at create).
	getDb()
		.prepare('UPDATE conversations SET workdir = ?, updated_at = ? WHERE id = ?')
		.run(newWorkdir, Date.now(), newConv.id);

	// Clone the message prefix (everything strictly before the edited
	// message), then append the edited content as a fresh user message in
	// the new conversation. Cloned rows get new IDs but preserve role,
	// content, and relative ordering (timestamps are reassigned monotonically
	// based on now() so the new conversation has a sensible single-pass
	// chronology).
	const prefix = all.slice(0, targetIdx);
	cloneMessagePrefix(newConv.id, prefix);
	messages.append(newConv.id, { role: 'user', content: input.newContent });

	const refreshed = convs.get(newConv.id, input.userId);
	if (!refreshed) throw new Error('fork: created conversation disappeared');
	log.info('fork.created', {
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
