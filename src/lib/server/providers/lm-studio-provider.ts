import { ulid } from 'ulid';
import { loadConfig } from '../config';
import { log } from '../log';
import { AsyncQueue } from '../runtime/async-queue';
import { jsonRequestHeaders, parseJson, streamSseEvents } from './provider-utils';
import type { BackendProviderId, PortalEvent } from '$lib/types';
import type {
	ModelBackendProvider,
	ProviderAuthStatus,
	ProviderModelInfo,
	ProviderOpenOptions,
	ProviderSession
} from './provider';

interface LMStudioConfig {
	id: Extract<BackendProviderId, 'lm-studio'>;
	displayName: string;
	baseUrl: string;
	apiKey: string | null;
	/** Best known effective context window, used for portal context metering. */
	tokenLimit: number | null;
	reasoning: 'off' | 'low' | 'medium' | 'high' | 'on' | null;
}

interface LMStudioModel {
	type?: string;
	key?: string;
	display_name?: string;
	max_context_length?: number;
	loaded_instances?: Array<{ id?: string; config?: { context_length?: number } }>;
	variants?: string[];
	selected_variant?: string;
}

interface ModelsResponse {
	models?: LMStudioModel[];
	error?: {
		message?: string;
	};
}

interface ChatEndResult {
	response_id?: string;
	stats?: {
		input_tokens?: number;
		total_output_tokens?: number;
		reasoning_output_tokens?: number;
	};
}

interface LMStudioStreamEvent {
	type?: string;
	content?: string;
	progress?: number;
	tool?: string;
	arguments?: unknown;
	output?: string;
	reason?: string;
	metadata?: {
		tool_name?: string;
		arguments?: unknown;
	};
	error?: {
		type?: string;
		message?: string;
		code?: string;
	};
	result?: ChatEndResult;
}

const providerId = 'lm-studio' satisfies Extract<BackendProviderId, 'lm-studio'>;
const displayName = 'LM Studio';
const DEFAULT_TEMPERATURE = 0.8;
const MODEL_CONTEXT_CACHE_TTL_MS = 5 * 60_000;
const modelContextCache = new Map<string, { at: number; contextLength: number }>();

export const lmStudioProvider: ModelBackendProvider = {
	id: providerId,
	displayName,
	ui: {
		chatPlaceholder: 'Message LM Studio...',
		defaultModelPlaceholder: 'publisher/model-name',
		setupHint:
			'Start the LM Studio local server. The native REST provider uses LMSTUDIO_BASE_URL (default http://127.0.0.1:1234) and LMSTUDIO_API_KEY when server auth is enabled.',
		setupHintVisibility: 'always'
	},
	status: {
		probe: 'when-default',
		skippedStatusMessage: 'Not checked because LM Studio is not the default provider.'
	},
	capabilities: {
		authStatus: true,
		modelList: true,
		session: {
			open: true,
			resume: true,
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
		features: {
			modes: {
				supported: false,
				behavior: 'no-op',
				label: 'Runtime modes',
				description:
					'LM Studio native chats do not expose Copilot runtime modes. Saved modes are retained for portal state but are not sent to LM Studio.'
			},
			approveAll: {
				supported: false,
				behavior: 'no-op',
				label: 'Approve all',
				description:
					'LM Studio native REST does not accept portal-hosted custom tools, so approve-all has no provider-side effect.'
			},
			contextUsage: {
				supported: true,
				behavior: 'supported',
				label: 'Context usage',
				description:
					'LM Studio token stats are shown when the context window is known from model metadata.'
			},
			subagents: {
				supported: false,
				behavior: 'unsupported',
				label: 'Subagents',
				description:
					'The Copilot subagent/task runtime is unavailable in LM Studio native REST sessions.'
			},
			mcpInfoEvents: {
				supported: false,
				behavior: 'unsupported',
				label: 'MCP info events',
				description:
					'LM Studio plugin and MCP tool calls are streamed as tool call/result events, but Copilot-style MCP informational requests are not emitted.'
			},
			planExit: {
				supported: false,
				behavior: 'unsupported',
				label: 'Plan exit',
				description: 'LM Studio native REST sessions do not support Copilot plan-exit callbacks.'
			},
			elicitation: {
				supported: false,
				behavior: 'unsupported',
				label: 'Elicitation',
				description: 'LM Studio native REST sessions do not support Copilot elicitation callbacks.'
			}
		},
		optionalRuntimeFeatures: {
			infiniteSessionMetadata: true,
			permissionCallbacks: false,
			userInputCallbacks: false,
			elicitationCallbacks: false,
			exitPlanModeCallbacks: false,
			autoModeSwitchCallbacks: false,
			contextWindowEvents: true,
			contextCompactionEvents: false,
			fileEditEvents: false,
			reasoningEvents: true,
			subagentLifecycleEvents: false
		}
	},
	async fetchAuthStatus(): Promise<ProviderAuthStatus> {
		const cfg = providerConfig();
		try {
			const res = await fetch(endpoint(cfg.baseUrl, '/models'), {
				headers: requestHeaders(cfg)
			});
			if (res.ok) {
				return {
					isAuthenticated: true,
					authType: cfg.apiKey ? 'api-token' : 'none',
					statusMessage: cfg.baseUrl
				};
			}
			return {
				isAuthenticated: false,
				authType: cfg.apiKey ? 'api-token' : undefined,
				statusMessage: `${displayName} returned ${res.status}: ${res.statusText}`
			};
		} catch (e) {
			return {
				isAuthenticated: false,
				statusMessage: backendErrorMessage(cfg, e)
			};
		}
	},
	async listModels(): Promise<ProviderModelInfo[]> {
		const cfg = providerConfig();
		try {
			const res = await fetch(endpoint(cfg.baseUrl, '/models'), {
				headers: requestHeaders(cfg)
			});
			const body = (await parseJson(res)) as ModelsResponse;
			if (!res.ok) {
				log.warn('lm_studio.models_failed', {
					status: res.status,
					err: body.error?.message ?? res.statusText
				});
				return [];
			}
			return (body.models ?? [])
				.filter((model) => model.type === 'llm' && typeof model.key === 'string')
				.map((model) => {
					const loadedId = model.loaded_instances?.find((instance) => instance.id)?.id;
					const maxContext =
						model.loaded_instances?.find((instance) => instance.config?.context_length)?.config
							?.context_length ?? model.max_context_length;
					return {
						id: loadedId ?? model.key!,
						name: model.display_name ?? model.key!,
						capabilities:
							typeof maxContext === 'number'
								? { limits: { max_context_window_tokens: maxContext } }
								: undefined
					};
				});
		} catch (e) {
			log.warn('lm_studio.models_failed', { err: String(e) });
			return [];
		}
	},
	async openSession(opts: ProviderOpenOptions): Promise<ProviderSession> {
		const cfg = providerConfig();
		return openLMStudioSession(await withTokenLimit(cfg, opts.model), opts);
	},
	shouldEmbedPriorMessages(providerSessionId: string): boolean {
		return !providerSessionId.startsWith('resp_');
	}
};

function providerConfig(): LMStudioConfig {
	const cfg = loadConfig();
	return {
		id: providerId,
		displayName,
		baseUrl: cfg.LMSTUDIO_BASE_URL,
		apiKey: cfg.LMSTUDIO_API_KEY ?? null,
		tokenLimit: null,
		reasoning: cfg.LMSTUDIO_REASONING ?? null
	};
}

function requestHeaders(cfg: LMStudioConfig): HeadersInit {
	return jsonRequestHeaders(cfg.apiKey);
}

function endpoint(baseUrl: string, path: string): string {
	const base = baseUrl.replace(/\/+$/, '');
	return `${base.endsWith('/api/v1') ? base : `${base}/api/v1`}${path}`;
}

async function withTokenLimit(cfg: LMStudioConfig, modelId: string): Promise<LMStudioConfig> {
	if (cfg.tokenLimit) return cfg;
	const tokenLimit = await fetchModelContextLength(cfg, modelId);
	return { ...cfg, tokenLimit };
}

async function fetchModelContextLength(
	cfg: LMStudioConfig,
	modelId: string
): Promise<number | null> {
	const cacheKey = `${cfg.baseUrl}\0${modelId}`;
	const cached = modelContextCache.get(cacheKey);
	if (cached && Date.now() - cached.at < MODEL_CONTEXT_CACHE_TTL_MS) {
		return cached.contextLength;
	}
	try {
		const res = await fetch(endpoint(cfg.baseUrl, '/models'), {
			headers: requestHeaders(cfg)
		});
		const body = (await parseJson(res)) as ModelsResponse;
		if (!res.ok) return null;
		const model = (body.models ?? []).find((candidate) => matchesModel(candidate, modelId));
		if (!model) return null;
		const exactLoadedContext = model.loaded_instances?.find((instance) => instance.id === modelId)
			?.config?.context_length;
		if (typeof exactLoadedContext === 'number') {
			modelContextCache.set(cacheKey, { at: Date.now(), contextLength: exactLoadedContext });
			return exactLoadedContext;
		}
		const firstLoadedContext = model.loaded_instances?.find(
			(instance) => instance.config?.context_length
		)?.config?.context_length;
		if (typeof firstLoadedContext === 'number') {
			modelContextCache.set(cacheKey, { at: Date.now(), contextLength: firstLoadedContext });
			return firstLoadedContext;
		}
		const contextLength =
			typeof model.max_context_length === 'number' ? model.max_context_length : null;
		if (contextLength !== null) {
			modelContextCache.set(cacheKey, { at: Date.now(), contextLength });
		}
		return contextLength;
	} catch (e) {
		log.warn('lm_studio.context_length_lookup_failed', { modelId, err: String(e) });
		return null;
	}
}

function matchesModel(model: LMStudioModel, modelId: string): boolean {
	return (
		model.type === 'llm' &&
		(model.key === modelId ||
			model.selected_variant === modelId ||
			model.variants?.includes(modelId) === true ||
			model.loaded_instances?.some((instance) => instance.id === modelId) === true)
	);
}

function backendErrorMessage(cfg: LMStudioConfig, e: unknown): string {
	if (e instanceof Error && e.name === 'AbortError') return 'Aborted by client.';
	if (e instanceof TypeError) {
		return `Unable to connect to ${cfg.displayName} backend at ${cfg.baseUrl}. Check that the LM Studio server is running and LMSTUDIO_BASE_URL points at it.`;
	}
	return e instanceof Error ? e.message : String(e);
}

function openLMStudioSession(cfg: LMStudioConfig, opts: ProviderOpenOptions): ProviderSession {
	let providerSessionId = opts.providerSessionId ?? opts.conversationId;
	let previousResponseId = providerSessionId.startsWith('resp_') ? providerSessionId : null;
	let aborted = false;
	let disposed = false;
	let activeAbortController: AbortController | null = null;
	let activeQueue: AsyncQueue<PortalEvent> | null = null;

	const session: ProviderSession = {
		provider: cfg.id,
		conversationId: opts.conversationId,
		providerSessionId,
		workingDirectory: opts.workingDirectory,
		lastUsed: Date.now(),
		async *send(prompt: string, signal: AbortSignal): AsyncIterable<PortalEvent> {
			if (activeQueue) throw new Error('session busy: a turn is already in progress');
			aborted = false;
			const messageId = ulid();
			const q = new AsyncQueue<PortalEvent>();
			activeQueue = q;
			const abort = new AbortController();
			activeAbortController = abort;
			const onAbort = () => {
				aborted = true;
				abort.abort();
			};
			signal.addEventListener('abort', onAbort, { once: true });
			if (signal.aborted) onAbort();
			void (async () => {
				try {
					await runTurn(cfg, opts, prompt, q, messageId, abort.signal, {
						getPreviousResponseId: () => previousResponseId,
						setPreviousResponseId: (id) => {
							previousResponseId = id;
							providerSessionId = id;
							session.providerSessionId = id;
						},
						isDisposed: () => disposed,
						isAborted: () => aborted
					});
				} catch (e) {
					if (aborted) {
						q.push({ type: 'error', code: 'aborted', message: 'Aborted by client.' });
					} else {
						log.warn('lm_studio.session.send_failed', {
							conversationId: opts.conversationId,
							err: String(e)
						});
						q.push({
							type: 'error',
							code: 'send_failed',
							message: backendErrorMessage(cfg, e)
						});
					}
				} finally {
					q.push({ type: 'message.end', messageId });
					q.push({ type: 'done' });
					q.end();
				}
			})();
			try {
				for await (const ev of q) {
					opts.onEvent?.(ev);
					yield ev;
				}
			} finally {
				signal.removeEventListener('abort', onAbort);
				if (activeAbortController === abort) activeAbortController = null;
				if (activeQueue === q) activeQueue = null;
				this.lastUsed = Date.now();
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
	return session;
}

async function runTurn(
	cfg: LMStudioConfig,
	opts: ProviderOpenOptions,
	prompt: string,
	q: AsyncQueue<PortalEvent>,
	messageId: string,
	signal: AbortSignal,
	state: {
		getPreviousResponseId: () => string | null;
		setPreviousResponseId: (id: string) => void;
		isDisposed: () => boolean;
		isAborted: () => boolean;
	}
) {
	q.push({ type: 'message.start', messageId, role: 'assistant' });
	if (state.isDisposed()) {
		q.push({ type: 'error', code: 'session_disposed', message: 'Session disposed.' });
		return;
	}
	const body: Record<string, unknown> = {
		model: opts.model,
		input: prompt,
		stream: true,
		store: true,
		temperature: DEFAULT_TEMPERATURE
	};
	const previousResponseId = state.getPreviousResponseId();
	if (previousResponseId) body.previous_response_id = previousResponseId;
	if (cfg.reasoning) body.reasoning = cfg.reasoning;

	const res = await fetch(endpoint(cfg.baseUrl, '/chat'), {
		method: 'POST',
		headers: requestHeaders(cfg),
		body: JSON.stringify(body),
		signal
	});
	await streamNativeChat(cfg, opts, res, messageId, q, state);
}

async function streamNativeChat(
	cfg: LMStudioConfig,
	opts: ProviderOpenOptions,
	res: Response,
	messageId: string,
	q: AsyncQueue<PortalEvent>,
	state: {
		setPreviousResponseId: (id: string) => void;
		isAborted: () => boolean;
	}
) {
	if (!res.ok) {
		const body = (await parseJson(res)) as { error?: { message?: string } };
		throw new Error(body.error?.message ?? `${cfg.displayName} chat failed: ${res.status}`);
	}
	if (!res.body) throw new Error(`${cfg.displayName} chat response did not include a body.`);

	let reasoningSegmentId: string | null = null;
	let reasoningStartedAt = 0;
	let currentTool: { id: string; tool: string; called: boolean; args: unknown } | null = null;
	let stats: ChatEndResult['stats'] | undefined;

	for await (const sse of streamSseEvents(res.body)) {
		if (state.isAborted()) return;
		const event = JSON.parse(sse.data) as LMStudioStreamEvent;
		const type = event.type ?? sse.event;
		if (type === 'message.delta' && typeof event.content === 'string') {
			q.push({ type: 'message.delta', messageId, text: event.content });
		} else if (type === 'reasoning.start') {
			reasoningSegmentId = ulid();
			reasoningStartedAt = Date.now();
		} else if (type === 'reasoning.delta' && typeof event.content === 'string') {
			if (!reasoningSegmentId) {
				reasoningSegmentId = ulid();
				reasoningStartedAt = Date.now();
			}
			q.push({
				type: 'message.reasoning',
				messageId,
				segmentId: reasoningSegmentId,
				text: event.content
			});
		} else if (type === 'reasoning.end' && reasoningSegmentId) {
			q.push({
				type: 'message.reasoning.end',
				messageId,
				segmentId: reasoningSegmentId,
				durationMs: Date.now() - reasoningStartedAt
			});
			reasoningSegmentId = null;
		} else if (type === 'tool_call.start' && typeof event.tool === 'string') {
			currentTool = { id: ulid(), tool: event.tool, called: false, args: {} };
		} else if (type === 'tool_call.arguments' && currentTool) {
			currentTool.args = event.arguments ?? {};
			emitLmToolCall(q, currentTool);
		} else if (type === 'tool_call.success') {
			const tool =
				currentTool && currentTool.tool === event.tool
					? currentTool
					: {
							id: ulid(),
							tool: event.tool ?? 'lm_studio_tool',
							called: false,
							args: event.arguments ?? {}
						};
			tool.args = event.arguments ?? tool.args;
			emitLmToolCall(q, tool);
			q.push({
				type: 'tool.result',
				toolCallId: tool.id,
				ok: true,
				summary: outputSummary(event.output ?? ''),
				output: event.output ?? ''
			});
			currentTool = null;
		} else if (type === 'tool_call.failure') {
			const toolName = event.metadata?.tool_name ?? event.tool ?? 'lm_studio_tool';
			const args = event.metadata?.arguments ?? event.arguments ?? {};
			const tool = currentTool ?? {
				id: ulid(),
				tool: toolName,
				called: false,
				args
			};
			tool.args = args;
			emitLmToolCall(q, tool);
			const summary = event.reason ?? 'LM Studio tool call failed.';
			q.push({
				type: 'tool.result',
				toolCallId: tool.id,
				ok: false,
				summary,
				output: summary
			});
			currentTool = null;
		} else if (type === 'error') {
			q.push({
				type: 'error',
				code: event.error?.code ?? event.error?.type ?? 'lm_studio_error',
				message: event.error?.message ?? 'LM Studio reported an error.'
			});
		} else if (type === 'chat.end') {
			stats = event.result?.stats;
			const responseId = event.result?.response_id;
			if (responseId?.startsWith('resp_')) {
				try {
					if (opts.onProviderSessionIdChange) {
						await opts.onProviderSessionIdChange(responseId);
					}
					state.setPreviousResponseId(responseId);
				} catch (e) {
					log.warn('lm_studio.session_id_change_callback_failed', {
						conversationId: opts.conversationId,
						responseId,
						err: String(e)
					});
					throw e;
				}
			}
		}
	}

	if (stats?.input_tokens !== undefined && cfg.tokenLimit) {
		const outputTokens =
			typeof stats.total_output_tokens === 'number' ? stats.total_output_tokens : 0;
		const currentTokens = stats.input_tokens + outputTokens;
		q.push({
			type: 'context.usage',
			currentTokens,
			tokenLimit: cfg.tokenLimit,
			messagesLength: 0,
			conversationTokens: currentTokens,
			systemTokens: 0,
			toolDefinitionsTokens: 0
		});
	}
}

function emitLmToolCall(
	q: AsyncQueue<PortalEvent>,
	tool: { id: string; tool: string; called: boolean; args: unknown }
) {
	if (tool.called) return;
	tool.called = true;
	q.push({
		type: 'tool.call',
		toolCallId: tool.id,
		tool: `lm_studio:${tool.tool}`,
		args: tool.args
	});
}

function outputSummary(output: string): string {
	const singleLine = output.replace(/\s+/g, ' ').trim();
	if (!singleLine) return '(empty result)';
	return singleLine.length > 200 ? `${singleLine.slice(0, 197)}...` : singleLine;
}
