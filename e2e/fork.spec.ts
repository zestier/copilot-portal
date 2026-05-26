import { test, expect } from '@playwright/test';
import {
	createConversation,
	getConversation,
	waitForAssistantMessage
} from './helpers/conversations';
import { resetConversations } from './helpers/reset';

test.beforeEach(async ({ request }) => {
	await resetConversations(request);
});

/**
 * End-to-end fork (edit-and-retry) flow:
 *  1. Send a message in a conversation; the stub replies. A pre-snapshot
 *     is captured server-side for the user message.
 *  2. POST /messages/:id/fork with new content to fork from that user
 *     message.
 *  3. Verify the new conversation has the edited prompt, automatically gets
 *     a fresh stubbed reply, and the source conversation is untouched.
 */
test('fork by editing a user message produces a new conversation with the edited prompt', async ({
	page,
	request
}) => {
	const sourceId = await createConversation(request, 'Source');

	// Drive the first turn through the UI so the server captures the
	// pre-snapshot (the POST /turns endpoint is what calls snapshot()).
	await page.goto(`/conversations/${sourceId}`);
	const composer = page.getByPlaceholder(/Message GitHub Copilot/);
	await composer.click();
	await composer.fill('context seed');
	await composer.press('Enter');
	await waitForAssistantMessage(request, sourceId, 'Stubbed reply to: context seed');
	await expect(page.getByText('Stubbed reply to: context seed').first()).toBeVisible();
	await composer.click();
	await composer.fill('original prompt');
	await composer.press('Enter');
	await waitForAssistantMessage(request, sourceId, 'Stubbed reply to: original prompt');
	await expect(page.getByText('Stubbed reply to: original prompt').first()).toBeVisible();

	// Wait for the turn to finalize so the fork POST doesn't race against
	// an in-flight turn (source_busy).
	const msgs = await getConversation(request, sourceId);
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

	await waitForAssistantMessage(request, newId, /edited prompt/);
	const newMsgs = await getConversation(request, newId);
	const contents = (newMsgs.messages as Array<{ role: string; content: string }>).map(
		(m) => `${m.role}:${m.content}`
	);
	expect(contents).toContain('user:context seed');
	expect(contents).toContain('assistant:Stubbed reply to: context seed');
	expect(contents).toContain('user:edited prompt');
	const assistantReply = contents.find(
		(m) => m.startsWith('assistant:Stubbed reply to:') && m.includes('edited prompt')
	);
	expect(assistantReply).toContain('context seed');
	expect(assistantReply).toContain('Stubbed reply to: context seed');
	expect(assistantReply).toContain('edited prompt');
	expect(contents).not.toContain('user:original prompt');

	// Source conversation still has the original turn intact.
	const srcMsgs = await getConversation(request, sourceId);
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
	const sourceId = await createConversation(request, 'Source');

	await page.goto(`/conversations/${sourceId}`);
	const composer = page.getByPlaceholder(/Message GitHub Copilot/);
	await composer.click();
	await composer.fill('first');
	await composer.press('Enter');
	await waitForAssistantMessage(request, sourceId, 'Stubbed reply to: first');
	await expect(page.getByText('Stubbed reply to: first').first()).toBeVisible();

	const msgs = await getConversation(request, sourceId);
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

	const newMsgs = await getConversation(request, newId);
	const list = newMsgs.messages as Array<{ role: string; content: string }>;
	// Cloned: user "first" + assistant reply. No new user message yet.
	expect(list).toHaveLength(2);
	expect(list[0]).toMatchObject({ role: 'user', content: 'first' });
	expect(list[1]).toMatchObject({ role: 'assistant' });
});

test('inline edit replaces a user message, truncates later messages, and reruns in place', async ({
	page,
	request
}) => {
	const sourceId = await createConversation(request, 'Inline Source');

	await page.goto(`/conversations/${sourceId}`);
	const composer = page.getByPlaceholder(/Message GitHub Copilot/);
	await composer.click();
	await composer.fill('first prompt');
	await composer.press('Enter');
	await waitForAssistantMessage(request, sourceId, 'Stubbed reply to: first prompt');
	await expect(page.getByText('Stubbed reply to: first prompt').first()).toBeVisible();

	await composer.click();
	await composer.fill('second prompt');
	await composer.press('Enter');
	await waitForAssistantMessage(request, sourceId, 'Stubbed reply to: second prompt');
	await expect(page.getByText('Stubbed reply to: second prompt').first()).toBeVisible();

	const before = await getConversation(request, sourceId);
	const firstUser = (before.messages as Array<{ id: string; role: string; content: string }>).find(
		(m) => m.role === 'user' && m.content === 'first prompt'
	);
	expect(firstUser).toBeDefined();

	const editRes = await request.post(
		`/api/conversations/${sourceId}/messages/${firstUser!.id}/edit`,
		{ data: { content: 'first prompt edited inline' } }
	);
	expect(editRes.ok()).toBeTruthy();
	await waitForAssistantMessage(request, sourceId, 'Stubbed reply to: first prompt edited inline');

	const after = await getConversation(request, sourceId);
	const list = after.messages as Array<{ id: string; role: string; content: string }>;
	expect(list.map((m) => `${m.role}:${m.content}`)).toEqual([
		'user:first prompt edited inline',
		'assistant:Stubbed reply to: first prompt edited inline'
	]);
	expect(list[0].id).toBe(firstUser!.id);
});
