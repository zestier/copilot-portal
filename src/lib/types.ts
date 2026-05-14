// Shared types used by both client and server.

export type Role = 'user' | 'assistant' | 'system';
export type MessageStatus = 'complete' | 'streaming' | 'interrupted' | 'error';

export interface User {
	id: string;
	githubLogin: string;
	displayName: string | null;
	avatarUrl: string | null;
}

export interface Conversation {
	id: string;
	userId: string;
	title: string;
	workdir: string;
	model: string | null;
	createdAt: number;
	updatedAt: number;
	archivedAt: number | null;
}

export interface Message {
	id: string;
	conversationId: string;
	role: Role;
	content: string;
	status: MessageStatus;
	errorCode: string | null;
	createdAt: number;
	toolCalls?: ToolCallRecord[];
	fileEdits?: FileEditRecord[];
	// Optional assistant reasoning ("thinking") captured while the model was
	// composing the visible body. Only present for models that emit it.
	reasoning?: string;
	// Wall-clock duration of the reasoning phase. Persisted so reloaded
	// history can still show "Thought for Xs" on the collapsed block.
	reasoningDurationMs?: number | null;
}

export interface ToolCallRecord {
	id: string;
	messageId: string;
	tool: string;
	argsJson: string;
	resultJson: string | null;
	status: 'pending' | 'ok' | 'error' | 'denied';
	startedAt: number;
	endedAt: number | null;
	textOffset: number | null;
}

export interface FileEditRecord {
	id: string;
	messageId: string;
	path: string;
	diff: string;
	createdAt: number;
	textOffset: number | null;
}

export interface UserSettings {
	defaultModel: string | null;
	defaultWorkdir: string | null;
	defaultPolicy: PermissionPolicy;
	theme: 'dark' | 'light';
}

export type PermissionPolicy = 'prompt' | 'allow-readonly' | 'allow-all' | 'deny-all';

// --- Normalized streaming protocol (server -> client over SSE) ---

export type PortalEvent =
	| { type: 'message.start'; messageId: string; role: 'assistant' }
	| { type: 'message.delta'; messageId: string; text: string }
	| { type: 'message.reasoning'; messageId: string; text: string }
	| { type: 'message.end'; messageId: string }
	| { type: 'tool.call'; toolCallId: string; tool: string; args: unknown }
	| {
			type: 'tool.permission';
			requestId: string;
			tool: string;
			kind: string;
			summary: string;
			args: unknown;
	  }
	| {
			type: 'tool.result';
			toolCallId: string;
			ok: boolean;
			summary: string;
			output?: unknown;
	  }
	| { type: 'file.edit'; path: string; diff: string }
	| { type: 'conversation.update'; conversationId: string; title?: string }
	| { type: 'reasoning.summary'; text: string }
	| {
			type: 'context.usage';
			currentTokens: number;
			tokenLimit: number;
			messagesLength: number;
			systemTokens?: number;
			conversationTokens?: number;
			toolDefinitionsTokens?: number;
			isInitial?: boolean;
	  }
	| {
			type: 'context.compaction';
			phase: 'start' | 'complete';
			tokensRemoved?: number;
			messagesRemoved?: number;
	  }
	| { type: 'error'; code: string; message: string }
	| { type: 'heartbeat' }
	| { type: 'done' };

// Latest context-window snapshot persisted per conversation. Mirrors the
// shape of the `context.usage` PortalEvent (sans the `type` and `isInitial`
// transport fields) so the UI can seed its meter from page load.
export interface ConversationUsage {
	conversationId: string;
	currentTokens: number;
	tokenLimit: number;
	messagesLength: number;
	systemTokens: number | null;
	conversationTokens: number | null;
	toolDefinitionsTokens: number | null;
	updatedAt: number;
}

export type PermissionDecision = 'allow-once' | 'allow-always' | 'deny';

export interface PermissionRequestView {
	requestId: string;
	tool: string;
	kind: string;
	summary: string;
	args: unknown;
}
