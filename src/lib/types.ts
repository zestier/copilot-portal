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
	/** Set when this conversation was created by forking another one. */
	forkedFromConversationId: string | null;
	/** The message in the source conversation whose edit produced this fork. */
	forkedFromMessageId: string | null;
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
	// Ordered assistant reasoning segments ("thinking") interleaved with
	// content. Each segment is one contiguous burst of reasoning deltas
	// anchored to a text offset, with its own elapsed-time window. Only
	// populated for models that emit reasoning.
	reasoningBlocks?: ReasoningBlockRecord[];
}

export interface ReasoningBlockRecord {
	id: string;
	messageId: string;
	segmentIndex: number;
	text: string;
	// Where this segment appeared within the assistant's accumulated content
	// (mirrors ToolCallRecord.textOffset). NULL = legacy / unknown / child
	// of a sub-agent (not anchored to the outer assistant's text).
	textOffset: number | null;
	startedAt: number;
	durationMs: number | null;
	// When set, this block was emitted by a sub-agent spawned by the outer
	// `task` tool call with this id. Such blocks are rendered inside the
	// SubagentCall component, not at the message level.
	parentToolCallId: string | null;
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
	// See ReasoningBlockRecord.parentToolCallId. Sub-agents can in turn
	// invoke their own tools; those nested calls are children of the
	// outermost `task` tool call.
	parentToolCallId: string | null;
}

export interface FileEditRecord {
	id: string;
	messageId: string;
	path: string;
	diff: string;
	createdAt: number;
	textOffset: number | null;
	// See ReasoningBlockRecord.parentToolCallId.
	parentToolCallId: string | null;
}

export interface UserSettings {
	defaultModel: string | null;
	defaultWorkdir: string | null;
	defaultPolicy: PermissionPolicy;
	theme: 'dark' | 'light';
}

export type PermissionPolicy = 'prompt' | 'allow-readonly' | 'allow-all' | 'deny-all';

// --- Interactive requests ---
//
// The SDK can pause a turn to ask the host (us) for input: permission to run
// a tool, free-form text, structured form fields, approval to leave plan
// mode, etc. We normalize all of them into a single discriminated union so
// the UI has one event channel + one dialog component to switch on.

export type InteractiveKind =
	| 'permission'
	| 'auto_mode_switch'
	| 'user_input'
	| 'elicitation'
	| 'exit_plan_mode'
	// "info" kinds: the SDK fires these but does not expose a public
	// responder. We surface them so the user knows what's happening; the
	// turn proceeds whenever the SDK resolves the request on its own.
	| 'sampling'
	| 'mcp_oauth'
	| 'external_tool';

export interface InteractivePermissionView {
	kind: 'permission';
	tool: string;
	permissionKind: string;
	summary: string;
	args: unknown;
}

export interface InteractiveAutoModeSwitchView {
	kind: 'auto_mode_switch';
	errorCode?: string;
	retryAfterSeconds?: number;
}

export interface InteractiveUserInputView {
	kind: 'user_input';
	question: string;
	choices?: string[];
	allowFreeform: boolean;
}

export interface InteractiveElicitationView {
	kind: 'elicitation';
	message: string;
	mode: 'form' | 'url';
	url?: string;
	requestedSchema?: ElicitationSchema;
	elicitationSource?: string;
}

export interface InteractiveExitPlanModeView {
	kind: 'exit_plan_mode';
	summary: string;
	planContent?: string;
	actions: string[];
	recommendedAction: string;
}

export interface InteractiveSamplingView {
	kind: 'sampling';
	mcpServerName?: string;
	summary: string;
}

export interface InteractiveMcpOauthView {
	kind: 'mcp_oauth';
	mcpServerName?: string;
	authorizationUrl?: string;
	summary: string;
}

export interface InteractiveExternalToolView {
	kind: 'external_tool';
	toolName: string;
	summary: string;
}

export type InteractiveRequestViewBody =
	| InteractivePermissionView
	| InteractiveAutoModeSwitchView
	| InteractiveUserInputView
	| InteractiveElicitationView
	| InteractiveExitPlanModeView
	| InteractiveSamplingView
	| InteractiveMcpOauthView
	| InteractiveExternalToolView;

export type InteractiveRequestView = { requestId: string } & InteractiveRequestViewBody;

export type InteractiveResponse =
	| { kind: 'permission'; decision: PermissionDecision }
	| { kind: 'auto_mode_switch'; decision: 'yes' | 'yes_always' | 'no' }
	| { kind: 'user_input'; answer: string; wasFreeform?: boolean }
	| {
			kind: 'elicitation';
			action: 'accept' | 'decline' | 'cancel';
			content?: Record<string, string | number | boolean | string[]>;
	  }
	| {
			kind: 'exit_plan_mode';
			approved: boolean;
			selectedAction?: string;
			feedback?: string;
	  }
	// "info" kinds: client can only acknowledge / dismiss. Always 'ack'.
	| { kind: 'sampling'; action: 'ack' }
	| { kind: 'mcp_oauth'; action: 'ack' }
	| { kind: 'external_tool'; action: 'ack' };

export interface ElicitationSchema {
	type: 'object';
	properties: Record<string, ElicitationSchemaField>;
	required?: string[];
}

export type ElicitationSchemaField =
	| {
			type: 'string';
			title?: string;
			description?: string;
			enum?: string[];
			enumNames?: string[];
			minLength?: number;
			maxLength?: number;
			format?: 'email' | 'uri' | 'date' | 'date-time';
			default?: string;
	  }
	| {
			type: 'number' | 'integer';
			title?: string;
			description?: string;
			minimum?: number;
			maximum?: number;
			default?: number;
	  }
	| {
			type: 'boolean';
			title?: string;
			description?: string;
			default?: boolean;
	  }
	| {
			type: 'array';
			title?: string;
			description?: string;
			minItems?: number;
			maxItems?: number;
			items: { type: 'string'; enum?: string[] };
			default?: string[];
	  };

// --- Normalized streaming protocol (server -> client over SSE) ---

export type PortalEvent =
	| { type: 'message.start'; messageId: string; role: 'assistant' }
	| { type: 'message.delta'; messageId: string; text: string }
	| {
			type: 'message.reasoning';
			messageId: string;
			segmentId: string;
			text: string;
			// When set, this reasoning burst originated inside the sub-agent
			// spawned by the outer `task` tool call with this id.
			parentToolCallId?: string;
	  }
	| {
			type: 'message.reasoning.end';
			messageId: string;
			segmentId: string;
			durationMs: number;
			parentToolCallId?: string;
	  }
	| { type: 'message.end'; messageId: string }
	| {
			type: 'tool.call';
			toolCallId: string;
			tool: string;
			args: unknown;
			parentToolCallId?: string;
	  }
	| { type: 'interactive.request'; request: InteractiveRequestView }
	| {
			type: 'interactive.resolved';
			requestId: string;
			kind: InteractiveKind;
			// Free-form snapshot of the resolution for replay / audit. Specific
			// shape mirrors InteractiveResponse but is intentionally `unknown`
			// here so the SSE consumer can replay it without re-parsing.
			outcome: unknown;
	  }
	| {
			type: 'tool.result';
			toolCallId: string;
			ok: boolean;
			summary: string;
			output?: unknown;
			parentToolCallId?: string;
	  }
	| { type: 'file.edit'; path: string; diff: string; parentToolCallId?: string }
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

// --- File browser / git response shapes (shared by client & server) ---

export type ChangeStatus =
	| 'untracked'
	| 'ignored'
	| 'modified'
	| 'added'
	| 'deleted'
	| 'renamed'
	| 'conflicted';

export interface ChangeEntry {
	path: string;
	origPath: string | null;
	status: ChangeStatus;
	staged: boolean;
	unstaged: boolean;
	added: number | null;
	removed: number | null;
}

export interface ChangesResponse {
	initialized: boolean;
	entries: ChangeEntry[];
}
