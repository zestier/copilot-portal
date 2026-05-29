import { describe, expect, it } from 'vitest';
import {
	CHAT_STREAM_STALL_TIMEOUT_MS,
	streamRefreshAction
} from '../src/lib/client/chat-stream-recovery';

describe('chat stream recovery', () => {
	it('uses a conservative stall timeout', () => {
		expect(CHAT_STREAM_STALL_TIMEOUT_MS).toBeGreaterThanOrEqual(45_000);
	});

	it('finishes a local stream when refresh shows no active turn', () => {
		expect(
			streamRefreshAction({
				currentTurnId: 'turn-1',
				refreshedActiveTurnId: null,
				hasEventSource: true
			})
		).toBe('finish');
	});

	it('finishes a dangling local stream even when no active turn id is tracked', () => {
		expect(
			streamRefreshAction({
				currentTurnId: null,
				refreshedActiveTurnId: null,
				hasEventSource: true
			})
		).toBe('finish');
	});

	it('finishes a tracked turn even when the local EventSource is already gone', () => {
		expect(
			streamRefreshAction({
				currentTurnId: 'turn-1',
				refreshedActiveTurnId: null,
				hasEventSource: false
			})
		).toBe('finish');
	});

	it('stays idle when there is no local stream and refresh shows no active turn', () => {
		expect(
			streamRefreshAction({
				currentTurnId: null,
				refreshedActiveTurnId: null,
				hasEventSource: false
			})
		).toBe('stay-attached');
	});

	it('reattaches when refresh shows an active turn but no local stream', () => {
		expect(
			streamRefreshAction({
				currentTurnId: null,
				refreshedActiveTurnId: 'turn-1',
				hasEventSource: false
			})
		).toBe('reattach');
	});

	it('reattaches when an EventSource exists without a tracked turn id', () => {
		expect(
			streamRefreshAction({
				currentTurnId: null,
				refreshedActiveTurnId: 'turn-1',
				hasEventSource: true
			})
		).toBe('reattach');
	});

	it('reattaches when the local stream is missing for the same active turn', () => {
		expect(
			streamRefreshAction({
				currentTurnId: 'turn-1',
				refreshedActiveTurnId: 'turn-1',
				hasEventSource: false
			})
		).toBe('reattach');
	});

	it('reattaches when the authoritative active turn changed', () => {
		expect(
			streamRefreshAction({
				currentTurnId: 'turn-1',
				refreshedActiveTurnId: 'turn-2',
				hasEventSource: true
			})
		).toBe('reattach');
	});

	it('keeps an attached stream when refresh agrees it is still active', () => {
		expect(
			streamRefreshAction({
				currentTurnId: 'turn-1',
				refreshedActiveTurnId: 'turn-1',
				hasEventSource: true
			})
		).toBe('stay-attached');
	});
});
