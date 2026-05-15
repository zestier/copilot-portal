import { describe, it, expect } from 'vitest';
import { addPermission, removePermission } from '../src/lib/client/permission-queue';
import type { PermissionRequestView } from '../src/lib/types';

function req(id: string, overrides: Partial<PermissionRequestView> = {}): PermissionRequestView {
	return {
		requestId: id,
		tool: 'shell',
		kind: 'shell',
		summary: `cmd-${id}`,
		args: null,
		...overrides
	};
}

describe('permission-queue', () => {
	it('queues concurrent permission requests instead of clobbering them', () => {
		// Regression: previously the UI held a single `pendingPermission`
		// slot, so a second `tool.permission` event hid the first while it
		// stayed pending on the server, deadlocking the earlier tool call.
		let q: PermissionRequestView[] = [];
		q = addPermission(q, req('a'));
		q = addPermission(q, req('b'));
		q = addPermission(q, req('c'));
		expect(q.map((p) => p.requestId)).toEqual(['a', 'b', 'c']);
	});

	it('dedupes by requestId so replayed event logs do not double-insert', () => {
		let q: PermissionRequestView[] = [];
		q = addPermission(q, req('a', { summary: 'first' }));
		q = addPermission(q, req('a', { summary: 'replayed' }));
		expect(q).toHaveLength(1);
		// First insert wins; we don't want a replay to mutate the original
		// summary the user is already looking at.
		expect(q[0].summary).toBe('first');
	});

	it('removes only the resolved request, leaving siblings intact', () => {
		let q: PermissionRequestView[] = [req('a'), req('b'), req('c')];
		q = removePermission(q, 'b');
		expect(q.map((p) => p.requestId)).toEqual(['a', 'c']);
	});

	it('removePermission is a no-op for unknown ids', () => {
		const q: PermissionRequestView[] = [req('a'), req('b')];
		const next = removePermission(q, 'missing');
		expect(next.map((p) => p.requestId)).toEqual(['a', 'b']);
	});

	it('returns new array references so reactive frameworks detect updates', () => {
		const q: PermissionRequestView[] = [req('a')];
		const afterAdd = addPermission(q, req('b'));
		expect(afterAdd).not.toBe(q);
		const afterRemove = removePermission(afterAdd, 'a');
		expect(afterRemove).not.toBe(afterAdd);
	});
});
