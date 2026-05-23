import { describe, expect, it } from 'vitest';
import { SdkEventAdapter } from '../src/lib/server/copilot/sdk-events';
import type { AsyncQueue } from '../src/lib/server/copilot/async-queue';
import type { PortalEvent, SessionMode } from '../src/lib/types';

class FakeSdkSource {
	readonly handlers = new Map<string, (e: unknown) => void>();

	on(event: string, listener: (e: unknown) => void) {
		this.handlers.set(event, listener);
	}

	emit(event: string, payload: unknown) {
		this.handlers.get(event)?.(payload);
	}
}

function makeHarness() {
	const source = new FakeSdkSource();
	const events: PortalEvent[] = [];
	const subagentLifecycleEvents: Array<{
		toolCallId: string;
		agentId: string;
		status: 'running' | 'completed' | 'failed';
	}> = [];
	let ended = false;
	let mode: SessionMode = 'interactive';
	let queue: AsyncQueue<PortalEvent> | null = {
		push(ev: PortalEvent) {
			events.push(ev);
		},
		end() {
			ended = true;
		}
	} as AsyncQueue<PortalEvent>;
	const adapter = new SdkEventAdapter({
		conversationId: 'conv-1',
		getQueue: () => queue,
		setQueue: (next) => {
			queue = next;
		},
		getMode: () => mode,
		setMode: (next) => {
			mode = next;
		},
		onSubagentLifecycle: (ev) => {
			subagentLifecycleEvents.push(ev);
		}
	});
	adapter.attach(source);
	return {
		source,
		events,
		get ended() {
			return ended;
		},
		get mode() {
			return mode;
		},
		get queue() {
			return queue;
		},
		subagentLifecycleEvents
	};
}

describe('SdkEventAdapter subagent lifecycle', () => {
	it('emits and reports started/completed/failed lifecycle events', () => {
		const h = makeHarness();

		h.source.emit('subagent.started', {
			agentId: 'agent-1',
			data: { toolCallId: 'tool-1' }
		});
		h.source.emit('subagent.completed', { agentId: 'agent-1' });
		h.source.emit('subagent.started', {
			agentId: 'agent-2',
			data: { toolCallId: 'tool-2' }
		});
		h.source.emit('subagent.failed', { agentId: 'agent-2' });

		const expected = [
			{ toolCallId: 'tool-1', agentId: 'agent-1', status: 'running' },
			{ toolCallId: 'tool-1', agentId: 'agent-1', status: 'completed' },
			{ toolCallId: 'tool-2', agentId: 'agent-2', status: 'running' },
			{ toolCallId: 'tool-2', agentId: 'agent-2', status: 'failed' }
		];
		expect(h.subagentLifecycleEvents).toEqual(expected);
		expect(h.events.filter((e) => e.type === 'subagent.lifecycle')).toEqual(
			expected.map((e) => ({ type: 'subagent.lifecycle', ...e }))
		);
	});
});

describe('SdkEventAdapter zod event boundary', () => {
	it('translates valid SDK payloads into portal events', () => {
		const h = makeHarness();

		h.source.emit('assistant.reasoning_delta', { data: { deltaContent: 'thinking' } });
		h.source.emit('tool.execution_start', {
			data: { toolCallId: 'tool-1', toolName: 'bash', arguments: { command: 'echo hi' } }
		});
		h.source.emit('tool.execution_complete', {
			data: { toolCallId: 'tool-1', success: true, result: 'ok' }
		});
		h.source.emit('session.usage_info', {
			data: {
				currentTokens: 10,
				tokenLimit: 100,
				messagesLength: 2,
				isInitial: true
			}
		});
		h.source.emit('assistant.message_delta', { data: { deltaContent: 'hello' } });
		h.source.emit('session.idle', {});

		expect(h.events.map((e) => e.type)).toEqual([
			'message.start',
			'message.reasoning',
			'message.reasoning.end',
			'tool.call',
			'tool.result',
			'context.usage',
			'message.delta',
			'message.end',
			'done'
		]);
		expect(h.events.find((e) => e.type === 'tool.call')).toMatchObject({
			toolCallId: 'tool-1',
			tool: 'bash',
			args: { command: 'echo hi' }
		});
		expect(h.events.find((e) => e.type === 'context.usage')).toMatchObject({
			currentTokens: 10,
			tokenLimit: 100,
			messagesLength: 2,
			isInitial: true
		});
		expect(h.ended).toBe(true);
		expect(h.queue).toBeNull();
	});

	it('drops malformed SDK payloads instead of translating wrong shapes', () => {
		const h = makeHarness();

		h.source.emit('assistant.message_delta', { data: { deltaContent: 123 } });
		h.source.emit('tool.execution_progress', {
			data: { toolCallId: 'tool-1', progressMessage: { text: 'not a string' } }
		});
		h.source.emit('session.usage_info', {
			data: { currentTokens: '10', tokenLimit: 100, messagesLength: 2 }
		});
		h.source.emit('mode.changed', { data: { newMode: 123 } });

		expect(h.events).toEqual([]);
		expect(h.mode).toBe('interactive');
	});

	it('accepts mode changes only after payload validation and known mode filtering', () => {
		const h = makeHarness();

		h.source.emit('mode.changed', { data: { newMode: 'plan' } });
		h.source.emit('mode.changed', { data: { newMode: 'unsupported' } });

		expect(h.mode).toBe('plan');
		expect(h.events).toHaveLength(1);
		expect(h.events[0]).toMatchObject({
			type: 'session.settings',
			conversationId: 'conv-1',
			mode: 'plan',
			source: 'agent'
		});
	});
});
