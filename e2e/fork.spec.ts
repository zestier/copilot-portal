import { test, expect } from '@playwright/test';
import { resetConversations } from './helpers/reset';
import type { APIRequestContext } from '@playwright/test';

test.beforeEach(async ({ request }) => {
	await resetConversations(request);
});

async function waitForIdle(request: APIRequestContext, conversationId: string) {
	// Poll the conversation GET until no turn is active. The stub bridge
	// makes turns near-instant but there's still a window between the
	// final assistant message landing and the turn status flipping to
	// "complete" — forking during that window returns source_busy.
	for (let i = 0; i < 50; i++) {
		const body = await request.get(`/api/conversations/${conversationId}`).then((r) => r.json());
		if (!body.activeTurnId) return body;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error('turn did not become idle');
}

/**
 * End-to-end fork (edit-and-retry) flow:
 *  1. Send a message in a conversation; the stub replies. A pre-snapshot
 *     is captured server-side for the user message.
 *  2. POST /messages/:id/fork with new content to fork from that user
 *     message.
 *  3. Verify the new conversation has the edited prompt, contains a fresh
 *     stubbed reply, and the source conversation is untouched.
 */
test('fork by editing a user message produces a new conversation with the edited prompt', async ({
	page,
	request
}) => {
	const created = await request
		.post('/api/conversations', { data: { title: 'Source' } })
		.then((r) => r.json());
	const sourceId = created.conversation.id as string;

	// Drive the first turn through the UI so the server captures the
	// pre-snapshot (the POST /turns endpoint is what calls snapshot()).
	await page.goto(`/conversations/${sourceId}`);
	const composer = page.getByPlaceholder(/Message Copilot/);
	await composer.click();
	await composer.fill('original prompt');
	await composer.press('Enter');
	await expect(page.getByText('Stubbed reply to: original prompt').first()).toBeVisible({
		timeout: 10_000
	});

	// Wait for the turn to finalize so the fork POST doesn't race against
	// an in-flight turn (source_busy).
	const msgs = await waitForIdle(request, sourceId);
	const userMsg = (msgs.messages as Array<{ id: string; role: string; content: string }>).find(
		(m) => m.role === 'user' && m.content === 'original prompt'
	);
	expect(userMsg).toBeDefined();

	// Fork with new content.
	const forkRes = await request.post(
		`/api/conversations/${sourceId}/messages/${userMsg!.id}/fork`,
		{ data: { content: 'edited prompt' } }
	);
	expect(forkRes.ok()).toBeTruthy();
	const { conversationId: newId } = await forkRes.json();
	expect(typeof newId).toBe('string');
	expect(newId).not.toBe(sourceId);

	// The new conversation has the edited user message but no assistant
	// reply yet (the client is expected to navigate and trigger a turn).
	const newMsgs = await request.get(`/api/conversations/${newId}`).then((r) => r.json());
	const contents = (newMsgs.messages as Array<{ role: string; content: string }>).map(
		(m) => `${m.role}:${m.content}`
	);
	expect(contents).toContain('user:edited prompt');
	expect(contents).not.toContain('user:original prompt');

	// Source conversation still has the original turn intact.
	const srcMsgs = await request.get(`/api/conversations/${sourceId}`).then((r) => r.json());
	const srcContents = (srcMsgs.messages as Array<{ role: string; content: string }>).map(
		(m) => m.content
	);
	expect(srcContents).toContain('original prompt');
	expect(srcContents).toContain('Stubbed reply to: original prompt');
});

test('retry from an assistant message clones up to it without a new user prompt', async ({
	page,
	request
}) => {
	const created = await request
		.post('/api/conversations', { data: { title: 'Source' } })
		.then((r) => r.json());
	const sourceId = created.conversation.id as string;

	await page.goto(`/conversations/${sourceId}`);
	const composer = page.getByPlaceholder(/Message Copilot/);
	await composer.click();
	await composer.fill('first');
	await composer.press('Enter');
	await expect(page.getByText('Stubbed reply to: first').first()).toBeVisible({
		timeout: 10_000
	});

	const msgs = await waitForIdle(request, sourceId);
	const assistantMsg = (msgs.messages as Array<{ id: string; role: string; content: string }>).find(
		(m) => m.role === 'assistant'
	);
	expect(assistantMsg).toBeDefined();

	const forkRes = await request.post(
		`/api/conversations/${sourceId}/messages/${assistantMsg!.id}/fork`,
		{ data: {} }
	);
	expect(forkRes.ok()).toBeTruthy();
	const { conversationId: newId } = await forkRes.json();

	const newMsgs = await request.get(`/api/conversations/${newId}`).then((r) => r.json());
	const list = newMsgs.messages as Array<{ role: string; content: string }>;
	// Cloned: user "first" + assistant reply. No new user message yet.
	expect(list).toHaveLength(2);
	expect(list[0]).toMatchObject({ role: 'user', content: 'first' });
	expect(list[1]).toMatchObject({ role: 'assistant' });
});
