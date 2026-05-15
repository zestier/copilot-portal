// Pure queue helpers for in-flight permission prompts.
//
// The SDK can fire multiple `onPermissionRequest` callbacks concurrently
// (parallel tool calls), so the UI must hold them in a queue rather than a
// single slot — otherwise a later `tool.permission` event clobbers the
// earlier one, hiding the prompt while it stays pending on the server and
// deadlocking that tool call.
//
// Resolutions (`tool.permission.resolved`) drop the matching entry by
// `requestId`. This is also what protects against replayed event logs
// resurrecting prompts the user already answered.

import type { PermissionRequestView } from '$lib/types';

export function addPermission(
	queue: PermissionRequestView[],
	req: PermissionRequestView
): PermissionRequestView[] {
	// Dedupe by requestId so replaying the turn's event log on reconnect
	// doesn't double-insert prompts already in the queue.
	if (queue.some((p) => p.requestId === req.requestId)) return queue;
	return [...queue, req];
}

export function removePermission(
	queue: PermissionRequestView[],
	requestId: string
): PermissionRequestView[] {
	return queue.filter((p) => p.requestId !== requestId);
}
