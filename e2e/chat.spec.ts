import { test, expect } from '@playwright/test';
import { createConversation, waitForAssistantMessage } from './helpers/conversations';
import { resetConversations } from './helpers/reset';

test.beforeEach(async ({ request }) => {
	await resetConversations(request);
});

test('streamed assistant reply (stubbed) appears and persists across reloads', async ({
	page,
	request
}) => {
	const id = await createConversation(request, 'E2E chat');
	await page.goto(`/conversations/${id}`);

	const composer = page.getByPlaceholder(/Message GitHub Copilot/);
	await composer.click();
	await composer.fill('hello world');
	await composer.press('Enter');

	await waitForAssistantMessage(request, id, 'Stubbed reply to: hello world');
	await expect(page.getByText('Stubbed reply to: hello world').first()).toBeVisible();

	// Reload and confirm both the user message and the assistant reply were
	// persisted (proves the turn-runner wrote them to SQLite).
	await page.reload();
	await expect(page.getByText('hello world', { exact: true }).first()).toBeVisible();
	await expect(page.getByText('Stubbed reply to: hello world').first()).toBeVisible();
});

test('rejects empty messages on the server', async ({ request }) => {
	const id = await createConversation(request, 'E2E chat');
	const res = await request.post(`/api/conversations/${id}/turns`, {
		data: { content: '' }
	});
	expect(res.ok()).toBeFalsy();
});
