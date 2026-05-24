import type {
	BackendProviderId,
	PortalEvent,
	PermissionPolicy,
	ProviderCapabilities,
	SessionMode
} from '$lib/types';

export type { ProviderCapabilities } from '$lib/types';

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

export interface ProviderUiInfo {
	chatPlaceholder: string;
	defaultModelPlaceholder: string;
	setupHint?: string;
	setupHintVisibility?: 'always' | 'when-unauthenticated';
}

export interface ProviderStatusBehavior {
	probe: 'always' | 'when-default';
	skippedStatusMessage?: string;
}

export interface ProviderOpenOptions {
	provider?: BackendProviderId;
	conversationId: string;
	providerSessionId?: string;
	userId: string;
	workingDirectory: string;
	model: string;
	policy: PermissionPolicy;
	/** Initial session mode. Providers without mode support may ignore it. */
	mode?: SessionMode;
	/** Initial approve-all setting. Providers without approve-all support may ignore it. */
	approveAllTools?: boolean;
	/** Provider-specific bearer credential resolved by the route layer, if needed. */
	providerAuthToken?: string;
	onEvent?: (e: PortalEvent) => void;
}

export interface ProviderSession {
	provider?: BackendProviderId;
	conversationId: string;
	providerSessionId: string;
	workingDirectory: string;
	lastUsed: number;
	send(prompt: string, signal: AbortSignal): AsyncIterable<PortalEvent>;
	abort(): Promise<void>;
	dispose(): Promise<void>;
	/** Optional live mode control. Persisting settings is caller-owned. */
	setMode?(mode: SessionMode): Promise<void>;
	/** Optional live approve-all control. Persisting settings is caller-owned. */
	setApproveAll?(enabled: boolean): Promise<void>;
	/** Optional provider/session-scoped approval cache reset. */
	resetSessionApprovals?(): Promise<void>;
}

export interface ModelBackendProvider {
	id: BackendProviderId;
	displayName: string;
	ui: ProviderUiInfo;
	status: ProviderStatusBehavior;
	capabilities: ProviderCapabilities;
	resolveAuthToken?(userId: string): string | undefined;
	fetchAuthStatus(userId: string, providerAuthToken?: string): Promise<ProviderAuthStatus>;
	listModels(userId: string, providerAuthToken?: string): Promise<ProviderModelInfo[]>;
	/**
	 * Open a conversation session. Providers that support resume should resume
	 * by `conversationId`; providers that do not should open a fresh backend
	 * session while keeping the portal conversation durable in SQLite.
	 */
	openSession(opts: ProviderOpenOptions): Promise<ProviderSession>;
	shutdown?(): Promise<void>;
}
