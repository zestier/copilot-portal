import type { BackendProviderId, PortalEvent, PermissionPolicy, SessionMode } from '$lib/types';

export interface ProviderAuthStatus {
	isAuthenticated: boolean;
	authType?: string;
	login?: string;
	statusMessage?: string;
}

export interface ProviderModelInfo {
	id: string;
	name: string;
	capabilities?: {
		limits?: {
			max_context_window_tokens?: number;
		};
	};
}

export interface ProviderCapabilities {
	authStatus: boolean;
	modelList: boolean;
	session: {
		open: true;
		/** Resume by conversation id when the provider has durable session state. */
		resume: boolean;
		dispose: true;
		abort: boolean;
	};
	stream: {
		send: true;
		/**
		 * Providers must normalize their native streaming protocol into PortalEvent.
		 * turn-runner consumes only this contract and should not depend on SDK-
		 * specific event shapes.
		 */
		contract: 'PortalEvent';
	};
	controls: {
		/** Supports live session modes such as plan/autopilot/best-effort. */
		mode: boolean;
		/** Supports live approve-all toggling for tool permission requests. */
		approveAll: boolean;
		/** Supports clearing provider/session-scoped approval grants. */
		resetSessionApprovals: boolean;
	};
	/**
	 * Copilot SDK features the portal can consume when present. Alternative
	 * providers, including OpenAI-compatible backends, may leave these false and
	 * still satisfy the core PortalEvent stream contract.
	 */
	optionalCopilotFeatures: {
		infiniteSessionMetadata: boolean;
		permissionCallbacks: boolean;
		userInputCallbacks: boolean;
		elicitationCallbacks: boolean;
		exitPlanModeCallbacks: boolean;
		autoModeSwitchCallbacks: boolean;
		contextWindowEvents: boolean;
		contextCompactionEvents: boolean;
		fileEditEvents: boolean;
		reasoningEvents: boolean;
		subagentLifecycleEvents: boolean;
	};
}

export interface ProviderOpenOptions {
	provider?: BackendProviderId;
	conversationId: string;
	userId: string;
	workingDirectory: string;
	model: string;
	policy: PermissionPolicy;
	/** Initial session mode. Providers without mode support may ignore it. */
	mode?: SessionMode;
	/** Initial approve-all setting. Providers without approve-all support may ignore it. */
	approveAllTools?: boolean;
	authToken?: string;
	onEvent?: (e: PortalEvent) => void;
}

export interface ProviderSession {
	provider?: BackendProviderId;
	conversationId: string;
	workingDirectory: string;
	lastUsed: number;
	send(prompt: string, signal: AbortSignal): AsyncIterable<PortalEvent>;
	abort(): Promise<void>;
	dispose(): Promise<void>;
	/** Optional Copilot-style live mode control. Persisting settings is caller-owned. */
	setMode?(mode: SessionMode): Promise<void>;
	/** Optional Copilot-style live approve-all control. Persisting settings is caller-owned. */
	setApproveAll?(enabled: boolean): Promise<void>;
	/** Optional Copilot-style session approval cache reset. */
	resetSessionApprovals?(): Promise<void>;
}

export interface ModelBackendProvider {
	id: BackendProviderId;
	displayName: string;
	capabilities: ProviderCapabilities;
	fetchAuthStatus(userId: string, authToken?: string): Promise<ProviderAuthStatus>;
	listModels(userId: string, authToken?: string): Promise<ProviderModelInfo[]>;
	/**
	 * Open a conversation session. Providers that support resume should resume
	 * by `conversationId`; providers that do not should open a fresh backend
	 * session while keeping the portal conversation durable in SQLite.
	 */
	openSession(opts: ProviderOpenOptions): Promise<ProviderSession>;
	shutdown?(): Promise<void>;
}
