import { ulid } from 'ulid';
import { loadConfig } from '../config';
import { log } from '../log';
import type { BackendProviderId, PortalEvent } from '$lib/types';
import type {
	ModelBackendProvider,
	ProviderAuthStatus,
	ProviderModelInfo,
	ProviderOpenOptions,
	ProviderSession
} from './provider';

interface OpenAICompatibleConfig {
	id: Extract<BackendProviderId, 'openai-compatible'>;
	displayName: string;
	baseUrl: string | null;
	apiKey: string | null;
}

interface ChatResponse {
	choices?: Array<{
		message?: {
			content?: string | null;
		};
		text?: string | null;
	}>;
	error?: {
		message?: string;
	};
}

interface ModelsResponse {
	data?: Array<{
		id?: string;
		name?: string;
	}>;
	error?: {
		message?: string;
	};
}

const providerId = 'openai-compatible' satisfies Extract<BackendProviderId, 'openai-compatible'>;
const displayName = 'OpenAI compatible';

export const openAICompatibleProvider: ModelBackendProvider = {
	id: providerId,
	displayName,
	capabilities: {
		authStatus: true,
		modelList: true,
		session: {
			open: true,
			resume: false,
			dispose: true,
			abort: false
		},
		stream: {
			send: true,
			contract: 'PortalEvent'
		},
		controls: {
			mode: false,
			approveAll: false,
			resetSessionApprovals: false
		},
		optionalCopilotFeatures: {
			infiniteSessionMetadata: false,
			permissionCallbacks: false,
			userInputCallbacks: false,
			elicitationCallbacks: false,
			exitPlanModeCallbacks: false,
			autoModeSwitchCallbacks: false,
			contextWindowEvents: false,
			contextCompactionEvents: false,
			fileEditEvents: false,
			reasoningEvents: false,
			subagentLifecycleEvents: false
		}
	},
	async fetchAuthStatus(): Promise<ProviderAuthStatus> {
		const cfg = providerConfig();
		if (!cfg.baseUrl) {
			return {
				isAuthenticated: false,
				statusMessage: `${displayName} requires a base URL.`
			};
		}
		return {
			isAuthenticated: true,
			authType: cfg.apiKey ? 'api-key' : 'none',
			statusMessage: cfg.baseUrl
		};
	},
	async listModels(): Promise<ProviderModelInfo[]> {
		const cfg = providerConfig();
		if (!cfg.baseUrl) return [];
		const res = await fetch(endpoint(cfg.baseUrl, '/models'), {
			headers: requestHeaders(cfg)
		});
		const body = (await res.json().catch(() => ({}))) as ModelsResponse;
		if (!res.ok) {
			throw new Error(body.error?.message ?? `${displayName} model list failed: ${res.status}`);
		}
		return (body.data ?? [])
			.filter((m): m is { id: string; name?: string } => typeof m.id === 'string')
			.map((m) => ({ id: m.id, name: m.name ?? m.id }));
	},
	async openSession(opts: ProviderOpenOptions): Promise<ProviderSession> {
		const cfg = providerConfig();
		if (!cfg.baseUrl) throw new Error(`${displayName} requires a base URL.`);
		return openOpenAICompatibleSession(cfg, opts);
	}
};

function providerConfig(): OpenAICompatibleConfig {
	const cfg = loadConfig();
	return {
		id: providerId,
		displayName,
		baseUrl: cfg.OPENAI_COMPATIBLE_BASE_URL ?? null,
		apiKey: cfg.OPENAI_COMPATIBLE_API_KEY ?? null
	};
}

function requestHeaders(cfg: OpenAICompatibleConfig): HeadersInit {
	const headers: Record<string, string> = {
		'content-type': 'application/json'
	};
	if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
	return headers;
}

function endpoint(baseUrl: string, path: string): string {
	const base = baseUrl.replace(/\/+$/, '');
	return `${base}${path}`;
}

function openOpenAICompatibleSession(
	cfg: OpenAICompatibleConfig,
	opts: ProviderOpenOptions
): ProviderSession {
	let aborted = false;
	return {
		provider: cfg.id,
		conversationId: opts.conversationId,
		workingDirectory: opts.workingDirectory,
		lastUsed: Date.now(),
		async *send(prompt: string, signal: AbortSignal): AsyncIterable<PortalEvent> {
			aborted = false;
			const messageId = ulid();
			yield { type: 'message.start', messageId, role: 'assistant' };
			const abort = new AbortController();
			const onAbort = () => {
				aborted = true;
				abort.abort();
			};
			signal.addEventListener('abort', onAbort, { once: true });
			try {
				const res = await fetch(endpoint(cfg.baseUrl!, '/chat/completions'), {
					method: 'POST',
					headers: requestHeaders(cfg),
					body: JSON.stringify({
						model: opts.model,
						messages: [{ role: 'user', content: prompt }],
						stream: false
					}),
					signal: abort.signal
				});
				const body = (await res.json().catch(() => ({}))) as ChatResponse;
				if (!res.ok) {
					throw new Error(body.error?.message ?? `${cfg.displayName} chat failed: ${res.status}`);
				}
				const text = body.choices?.[0]?.message?.content ?? body.choices?.[0]?.text ?? '';
				if (text) yield { type: 'message.delta', messageId, text };
			} catch (e) {
				if (aborted) {
					yield { type: 'error', code: 'aborted', message: 'Aborted by client.' };
				} else {
					log.warn('openai_compatible.session.send_failed', {
						provider: cfg.id,
						conversationId: opts.conversationId,
						err: String(e)
					});
					yield {
						type: 'error',
						code: 'send_failed',
						message: e instanceof Error ? e.message : String(e)
					};
				}
			} finally {
				signal.removeEventListener('abort', onAbort);
				this.lastUsed = Date.now();
				yield { type: 'message.end', messageId };
				yield { type: 'done' };
			}
		},
		async abort() {
			aborted = true;
		},
		async dispose() {
			aborted = true;
		}
	};
}
