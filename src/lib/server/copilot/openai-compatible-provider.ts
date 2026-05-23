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

interface ChatChoiceDelta {
	content?: unknown;
}

interface ChatStreamChunk {
	choices?: Array<{
		delta?: ChatChoiceDelta;
		message?: {
			content?: unknown;
		};
		text?: unknown;
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
			abort: true
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
		try {
			const res = await fetch(endpoint(cfg.baseUrl, '/models'), {
				headers: requestHeaders(cfg)
			});
			const body = (await parseJson(res)) as ModelsResponse;
			if (!res.ok) {
				log.warn('openai_compatible.models_failed', {
					provider: cfg.id,
					status: res.status,
					err: body.error?.message ?? res.statusText
				});
				return [];
			}
			return (body.data ?? [])
				.filter((m): m is { id: string; name?: string } => typeof m.id === 'string')
				.map((m) => ({ id: m.id, name: m.name ?? m.id }));
		} catch (e) {
			log.warn('openai_compatible.models_failed', {
				provider: cfg.id,
				err: String(e)
			});
			return [];
		}
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

async function parseJson(res: Response): Promise<unknown> {
	return await res.json().catch(() => ({}));
}

async function* streamSseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let dataLines: string[] = [];

	function drainLine(line: string): string | null {
		const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
		if (trimmed === '') {
			if (dataLines.length === 0) return null;
			const data = dataLines.join('\n');
			dataLines = [];
			return data;
		}
		if (trimmed.startsWith(':')) return null;
		const separator = trimmed.indexOf(':');
		const field = separator === -1 ? trimmed : trimmed.slice(0, separator);
		if (field !== 'data') return null;
		const value = separator === -1 ? '' : trimmed.slice(separator + 1).replace(/^ /, '');
		dataLines.push(value);
		return null;
	}

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newline = buffer.indexOf('\n');
			while (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const data = drainLine(line);
				if (data !== null) yield data;
				newline = buffer.indexOf('\n');
			}
		}
		buffer += decoder.decode();
		if (buffer) {
			const data = drainLine(buffer);
			if (data !== null) yield data;
		}
		if (dataLines.length > 0) yield dataLines.join('\n');
	} finally {
		reader.releaseLock();
	}
}

function stringContent(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.map((part) => {
			if (typeof part === 'string') return part;
			if (part && typeof part === 'object' && 'text' in part) {
				const text = (part as { text?: unknown }).text;
				return typeof text === 'string' ? text : '';
			}
			return '';
		})
		.join('');
}

function chunkText(chunk: ChatStreamChunk): string {
	const choice = chunk.choices?.[0];
	return (
		stringContent(choice?.delta?.content) ||
		stringContent(choice?.message?.content) ||
		stringContent(choice?.text)
	);
}

function backendErrorMessage(cfg: OpenAICompatibleConfig, e: unknown): string {
	if (e instanceof Error && e.name === 'AbortError') return 'Aborted by client.';
	if (e instanceof TypeError) {
		return `Unable to connect to ${cfg.displayName} backend at ${cfg.baseUrl}. Check that the server is running and OPENAI_COMPATIBLE_BASE_URL points at its /v1 endpoint.`;
	}
	return e instanceof Error ? e.message : String(e);
}

async function* streamChatCompletionText(
	cfg: OpenAICompatibleConfig,
	res: Response
): AsyncIterable<string> {
	if (!res.ok) {
		const body = (await parseJson(res)) as ChatStreamChunk;
		throw new Error(body.error?.message ?? `${cfg.displayName} chat failed: ${res.status}`);
	}
	if (!res.body) throw new Error(`${cfg.displayName} chat response did not include a body.`);

	for await (const data of streamSseData(res.body)) {
		if (data === '[DONE]') break;
		const chunk = JSON.parse(data) as ChatStreamChunk;
		if (chunk.error?.message) throw new Error(chunk.error.message);
		const text = chunkText(chunk);
		if (text) yield text;
	}
}

function openOpenAICompatibleSession(
	cfg: OpenAICompatibleConfig,
	opts: ProviderOpenOptions
): ProviderSession {
	let aborted = false;
	let disposed = false;
	let activeAbortController: AbortController | null = null;
	return {
		provider: cfg.id,
		conversationId: opts.conversationId,
		workingDirectory: opts.workingDirectory,
		lastUsed: Date.now(),
		async *send(prompt: string, signal: AbortSignal): AsyncIterable<PortalEvent> {
			aborted = false;
			const messageId = ulid();
			yield { type: 'message.start', messageId, role: 'assistant' };
			if (disposed) {
				this.lastUsed = Date.now();
				yield { type: 'error', code: 'session_disposed', message: 'Session disposed.' };
				yield { type: 'message.end', messageId };
				yield { type: 'done' };
				return;
			}
			const abort = new AbortController();
			activeAbortController = abort;
			const onAbort = () => {
				aborted = true;
				abort.abort();
			};
			signal.addEventListener('abort', onAbort, { once: true });
			if (signal.aborted) onAbort();
			try {
				const res = await fetch(endpoint(cfg.baseUrl!, '/chat/completions'), {
					method: 'POST',
					headers: requestHeaders(cfg),
					body: JSON.stringify({
						model: opts.model,
						messages: [{ role: 'user', content: prompt }],
						stream: true
					}),
					signal: abort.signal
				});
				for await (const text of streamChatCompletionText(cfg, res)) {
					if (aborted) break;
					yield { type: 'message.delta', messageId, text };
				}
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
						message: backendErrorMessage(cfg, e)
					};
				}
			} finally {
				signal.removeEventListener('abort', onAbort);
				if (activeAbortController === abort) activeAbortController = null;
				this.lastUsed = Date.now();
				yield { type: 'message.end', messageId };
				yield { type: 'done' };
			}
		},
		async abort() {
			aborted = true;
			activeAbortController?.abort();
		},
		async dispose() {
			disposed = true;
			aborted = true;
			activeAbortController?.abort();
		}
	};
}
