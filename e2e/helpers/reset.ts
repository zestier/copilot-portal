import type { APIRequestContext } from '@playwright/test';

/**
 * Delete every conversation visible to the current user, including
 * archived ones. Used in e2e `beforeEach` to keep the shared SQLite DB
 * from leaking conversation state across tests.
 */
export async function resetConversations(request: APIRequestContext): Promise<void> {
	const res = await request.get('/api/conversations?archived=1');
	if (!res.ok()) return; // server may not be ready yet on the very first run
	const body = (await res.json()) as { conversations: Array<{ id: string }> };
	await Promise.all(
		body.conversations.map((c) =>
			request.delete(`/api/conversations/${c.id}`).catch(() => undefined)
		)
	);
}
